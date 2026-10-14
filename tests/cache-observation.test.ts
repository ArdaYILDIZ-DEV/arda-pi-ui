import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MessageEndEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { buildCacheTimerLine, CacheTimerController, formatPromptCacheObservation, type CacheTimerPaint, type UiCtx } from "../cache-timer.ts";
import { cacheReadPercent, requestCacheLifetime, PromptCacheTracker, type CacheEntry, type CacheMessage } from "../prompt-cache.ts";

const model = { provider: "anthropic", id: "claude-test", api: "anthropic-messages", promptCache: { short: 300, long: 3600 } };
const usage = { input: 100, cacheRead: 700, cacheWrite: 200 };
const payload = { system: [{ type: "text", text: "private prompt", cache_control: { type: "ephemeral" } }] };
const message = (overrides: Partial<CacheMessage> = {}): CacheMessage => ({ role: "assistant", provider: model.provider, model: model.id, timestamp: 1_000_000, stopReason: "stop", usage, ...overrides });

const ctx = { hasUI: false } as UiCtx;

describe("cache request clock", () => {
	it("does not refresh the request clock on tool completion or settlement", (t) => {
		let now = 1_000_000;
		t.mock.method(Date, "now", () => now);
		const controller = new CacheTimerController({ soundEnabled: false });
		try {
			controller.handleBeforeProviderRequest(ctx);
			now += 120_000;
			controller.handleMessageEnd({ type: "message_end", message: { role: "assistant" } } as MessageEndEvent, ctx);
			now += 180_000;
			controller.handleTurnEnd({} as TurnEndEvent, ctx);
			controller.handleAgentSettled(ctx);
			assert.equal(controller.getLastContextTimestamp(), 1_000_000);
			assert.equal(controller.getState().elapsedMs, 300_000);
		} finally { controller.dispose(); }
	});

	it("does not treat a local user message as a provider cache refresh on resume", () => {
		const controller = new CacheTimerController({ soundEnabled: false });
		try {
			controller.handleSessionStart({ ...ctx, sessionManager: { getEntries: () => [
				{ type: "message", timestamp: new Date().toISOString(), message: { role: "user" } },
			] } });
			assert.equal(controller.getLastContextTimestamp(), null);
		} finally { controller.dispose(); }
	});
});

describe("provider cache observations", () => {
	it("sanitizes custom observation badges and git summaries before styling", () => {
		const identity = (value: string) => value;
		const paint: CacheTimerPaint = { colorize: identity, dim: identity, accent: identity, red: identity, scheme: "dark", colorMode: "truecolor" };
		const state = { elapsedMs: 0, columns: 100, hasContext: true, isProcessing: false, badgeText: "\u001b[2Jage 4dk / ttl ?\u0007", gitSummary: "\u001b]0;hostile\u0007main" };
		const line = buildCacheTimerLine(state, paint);
		assert.ok(!/[\u001b\u0007]/.test(line));
		assert.ok(line.startsWith("main"));
		assert.ok(line.endsWith("age 4dk / ttl ?"));
	});

	it("renders the configured local reminder duration instead of hard-coded five minutes", () => {
		const identity = (value: string) => value;
		const paint: CacheTimerPaint = { colorize: identity, dim: identity, accent: identity, red: identity, scheme: "dark", colorMode: "truecolor" };
		assert.ok(buildCacheTimerLine({ elapsedMs: 30_000, ttlMs: 60_000, columns: 80, hasContext: true, isProcessing: false }, paint).endsWith("30sn / 1dk"));
	});

	it("uses normalized uncached + read + write tokens, excluding output", () => {
		assert.equal(cacheReadPercent(usage), 70);
		assert.equal(cacheReadPercent({ input: 0, cacheRead: 500, cacheWrite: 0 }), 100);
		assert.equal(cacheReadPercent({ input: 0, cacheRead: 0, cacheWrite: 500 }), 0);
		for (const bad of [undefined, { input: NaN, cacheRead: 10, cacheWrite: 0 }, { input: -1, cacheRead: 1, cacheWrite: 0 }, { input: 0, cacheRead: 0, cacheWrite: 0 }]) assert.equal(cacheReadPercent(bad), undefined);
	});

	it("uses request TTLs and host model metadata, never universal five minutes", () => {
		assert.deepEqual(requestCacheLifetime(model, payload), { ttlMs: 300_000, ttlSource: "request" });
		assert.deepEqual(requestCacheLifetime(model, { cache_control: { type: "ephemeral", ttl: "1h" } }), { ttlMs: 3_600_000, ttlSource: "request" });
		assert.deepEqual(requestCacheLifetime({ ...model, api: "bedrock-converse-stream" }, { messages: [{ content: [{ cachePoint: { type: "default", ttl: "1h" } }] }] }), { ttlMs: 3_600_000, ttlSource: "request" });
		assert.deepEqual(requestCacheLifetime(model, {}), {});
		assert.deepEqual(requestCacheLifetime({ ...model, api: "openai-responses", promptCache: { short: 1800 } }, {}), { ttlMs: 1_800_000, ttlSource: "catalog" });
		assert.deepEqual(requestCacheLifetime({ ...model, api: "openai-responses", promptCache: undefined }, {}), {});
		assert.deepEqual(requestCacheLifetime(model, { prompt_cache_options: { ttl: "30m" } }), { ttlMs: 1_800_000, ttlSource: "request" });
		assert.deepEqual(requestCacheLifetime(model, { prompt_cache_options: { mode: "explicit" } }), {});
		assert.deepEqual(requestCacheLifetime({ ...model, promptCache: { long: 1800 } }, { prompt_cache_retention: "24h" }), { ttlMs: 1_800_000, ttlSource: "catalog" });
		assert.deepEqual(requestCacheLifetime({ ...model, promptCache: undefined }, { prompt_cache_retention: "24h" }), {}, "24h is a ceiling, not a guaranteed lease");
		assert.deepEqual(requestCacheLifetime(model, { cache_control: { ttl: "unknown" } }), {});
	});

	it("uses the shortest mixed TTL and does not mutate or retain request content", () => {
		const mixed = { system: [{ cache_control: { ttl: "1h" } }, { cache_control: { ttl: "5m" } }] };
		const before = JSON.stringify(mixed);
		assert.equal(requestCacheLifetime(model, mixed).ttlMs, 300_000);
		assert.equal(JSON.stringify(mixed), before);
		const cycle: Record<string, unknown> = {}; cycle.messages = [cycle];
		assert.deepEqual(requestCacheLifetime(model, cycle), {});
		assert.deepEqual(requestCacheLifetime(model, { messages: Array(10_001).fill({ cache_control: { ttl: "1h" } }) }), {});
	});

	it("ages from request start through streaming and tools without declaring a hit or expiry", (t) => {
		let now = 1_000_000;
		t.mock.method(Date, "now", () => now);
		const tracker = new PromptCacheTracker();
		tracker.request(model, payload);
		now += 240_000;
		const response = message(); tracker.message(response);
		const observed = tracker.observe(model, [{ type: "message", message: response }]);
		assert.equal(observed.timestamp, 1_000_000);
		assert.equal(observed.readPercent, 70);
		assert.equal(observed.ttlMs, 300_000);
		assert.equal(formatPromptCacheObservation(observed), "age 4dk 0sn / ~5dk");
		now += 360_000;
		assert.equal(formatPromptCacheObservation(observed), "age 10dk 0sn / ~5dk");
		assert.ok(!observed.reason.includes("aktif"));
	});

	it("does not invent cache activity for zero usage, errors, missing data or another model", (t) => {
		t.mock.method(Date, "now", () => 1_100_000);
		for (const response of [message({ usage: { input: 100, cacheRead: 0, cacheWrite: 0 } }), message({ stopReason: "error" }), message({ stopReason: "aborted" }), message({ usage: undefined }), message({ model: "different-model" })]) {
			const tracker = new PromptCacheTracker(); tracker.request(model, payload, 1_000_000); tracker.message(response);
			const observed = tracker.observe(model, [{ type: "message", message: response }]);
			assert.equal(observed.timestamp, undefined);
			assert.equal(observed.ttlMs, undefined);
		}
	});

	it("restores only the latest assistant on the active branch and keeps historical TTL unknown", (t) => {
		t.mock.method(Date, "now", () => 1_100_000);
		const tracker = new PromptCacheTracker();
		const entries: CacheEntry[] = [
			{ type: "message", message: message(), timestamp: new Date(1_080_000).toISOString() },
			{ type: "message", message: { role: "user" }, timestamp: new Date(1_090_000).toISOString() },
		];
		assert.equal(tracker.observe(model, entries).timestamp, 1_000_000, "assistant timestamp is request start, entry timestamp is completion");
		assert.equal(tracker.observe(model, entries).ttlMs, 300_000);
		assert.equal(tracker.observe(model, entries).ttlSource, "fallback");
		assert.equal(tracker.observe(model, [...entries, { type: "compaction" }]).readPercent, undefined);
		assert.equal(tracker.observe(model, [...entries, { type: "message", message: message({ usage: undefined }) }]).readPercent, undefined);
		assert.equal(tracker.observe({ ...model, id: "other" }, entries).readPercent, undefined);
		assert.equal(tracker.observe(model, [{ type: "message", message: message({ timestamp: 2_000_000 }) }]).timestamp, undefined);
	});

	it("keeps real-request read share separate from confirmed warm usage without guessing warm TTL", (t) => {
		t.mock.method(Date, "now", () => 1_200_000);
		const tracker = new PromptCacheTracker();
		const response = message(); tracker.request(model, payload, 1_000_000); tracker.message(response);
		const entries: CacheEntry[] = [
			{ type: "message", message: response },
			{ type: "usage", kind: "cache_warm", provider: model.provider, model: model.id, timestamp: new Date(1_150_000).toISOString(), usage: { input: 0, cacheRead: 1000, cacheWrite: 0 } },
		];
		const observed = tracker.observe(model, entries);
		assert.equal(observed.readPercent, 70);
		assert.equal(observed.source, "warm");
		assert.equal(observed.warmUsage?.cacheRead, 1000);
		assert.equal(observed.timestamp, 1_150_000);
		assert.equal(observed.ttlMs, 300_000);
		assert.equal(observed.ttlSource, "fallback");
		assert.equal(formatPromptCacheObservation(observed), "warm age ~50sn / ~5dk*");
		assert.equal(tracker.observe(model, entries.slice(0, 1)).source, "request");
		tracker.reset();
		assert.equal(tracker.observe(model).source, "unknown");
		const newer = message({ timestamp: 1_180_000 });
		assert.equal(tracker.observe(model, [...entries, { type: "message", message: newer }]).timestamp, 1_180_000, "older warming cannot replace a newer request");
		assert.equal(tracker.observe(model, [...entries.slice(0, 1), { ...entries[1], timestamp: new Date(900_000).toISOString() }]).source, "history");
	});

	it("does not carry request metadata across settlement, model APIs, or provider fallback", (t) => {
		t.mock.method(Date, "now", () => 1_100_000);
		const tracker = new PromptCacheTracker();
		tracker.request(model, payload, 1_000_000); tracker.settled(); tracker.message(message());
		assert.equal(tracker.observe(model).source, "unknown");
		tracker.request(model, payload, 1_000_000); tracker.message(message({ api: "other-api" }));
		assert.equal(tracker.observe(model).source, "unknown");
		tracker.request(model, payload, 1_000_000); tracker.message(message({ responseModel: "fallback" }));
		assert.equal(tracker.observe(model).readPercent, 70);
		assert.equal(tracker.observe(model).ttlMs, 300_000);
		assert.equal(tracker.observe(model).ttlSource, "fallback");
	});

	it("shows real provider ages during processing and scales warnings only with known evidence", (t) => {
		let now = 1_000_000; t.mock.method(Date, "now", () => now);
		const played: string[] = [];
		const controller = new CacheTimerController({ soundPlayer: (file) => played.push(file) });
		const current = { model, hasUI: true, ui: { setWidget: () => {} } } as unknown as UiCtx;
		try {
			controller.handleBeforeProviderRequest(current, { cache_control: { ttl: "1h" } });
			controller.handleMessageEnd({ type: "message_end", message: message() } as MessageEndEvent, current);
			controller.handleAgentSettled(current);
			now += 180_000; controller.repaint(current);
			assert.equal(played.length, 0, "1h cache has no 3min deadline");
			now = 1_000_000 + 1_800_000; controller.repaint(current);
			assert.equal(played.length, 1, "50% milestone scales to 30min");
			controller.handleAgentStart(current);
			assert.match(formatPromptCacheObservation(controller.getCacheObservation()), /^age 30dk/);
			assert.match(controller.getStatusSummary(), /Son istek cache read: %70/);
		} finally { controller.dispose(); }
	});
});
