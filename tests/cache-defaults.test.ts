import assert from "node:assert/strict";
import { it } from "node:test";
import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { CacheTimerController, formatPromptCacheObservation, type UiCtx } from "../cache-timer.ts";
import { PromptCacheTracker } from "../prompt-cache.ts";

it("uses a labelled five-minute fallback only when cache usage is observed", (t) => {
	t.mock.method(Date, "now", () => 1_100_000);
	const tracker = new PromptCacheTracker();
	const model = { provider: "unknown", id: "test" };
	const response = { role: "assistant", provider: model.provider, model: model.id, timestamp: 1_000_000, usage: { input: 100, cacheRead: 900, cacheWrite: 0 } };
	const observed = tracker.observe(model, [{ type: "message", message: response }]);
	assert.equal(observed.ttlMs, 300_000);
	assert.equal(observed.ttlSource, "fallback");
	assert.equal(formatPromptCacheObservation(observed), "age 1dk 40sn / ~5dk*");
	assert.match(observed.reason, /varsayılan/);
	assert.equal(tracker.observe(model, [{ type: "message", message: { ...response, usage: { input: 100, cacheRead: 0, cacheWrite: 0 } } }]).ttlMs, undefined);
});

for (const ttlMs of [300_000, 600_000]) it(`starts sounds halfway through a ${ttlMs / 60_000}-minute window`, () => {
	const played: number[] = [];
	const controller = new CacheTimerController({ ttlMs, soundPlayer: (_file, repeat = 1) => played.push(repeat) });
	try {
		controller.setLastContextTimestamp(Date.now());
		controller.checkSoundMilestones(ttlMs / 2 - 1);
		assert.equal(played.length, 0);
		controller.checkSoundMilestones(ttlMs / 2);
		controller.checkSoundMilestones(ttlMs / 2 + 1);
		assert.deepEqual(played, [1]);
		controller.checkSoundMilestones(ttlMs * 0.8);
		controller.checkSoundMilestones(ttlMs * 0.9);
		assert.deepEqual(played, [1, 1, 2]);
	} finally { controller.dispose(); }
});

it("uses the fallback window for automatic provider sound warnings", (t) => {
	let now = 1_000_000; t.mock.method(Date, "now", () => now);
	const model = { provider: "xai", id: "test", api: "openai-completions" };
	const current = { model, hasUI: true, ui: { setWidget: () => {} } } as unknown as UiCtx;
	const played: number[] = [];
	const controller = new CacheTimerController({ soundPlayer: (_file, repeat = 1) => played.push(repeat) });
	try {
		controller.handleBeforeProviderRequest(current, {});
		controller.handleMessageEnd({ type: "message_end", message: { role: "assistant", provider: model.provider, model: model.id, timestamp: now, stopReason: "stop", usage: { input: 100, cacheRead: 900, cacheWrite: 0 } } } as MessageEndEvent, current);
		controller.handleAgentSettled(current);
		now += 149_999; controller.repaint(current); assert.equal(played.length, 0);
		now++; controller.repaint(current); assert.deepEqual(played, [1]);
		assert.match(controller.getStatusSummary(), /5dk varsayılan/);
	} finally { controller.dispose(); }
});

it("rejects invalid sound ratio tuples and keeps the half-window default", () => {
	for (const ratios of [[0, 0.8, 0.9], [0.5, 0.5, 0.9], [0.9, 0.8, 0.5], [0.5, 0.8, 1], [NaN, 0.8, 0.9]] as const) {
		const played: number[] = [];
		const controller = new CacheTimerController({ soundMilestoneRatios: ratios, soundPlayer: () => played.push(1) });
		try {
			controller.setLastContextTimestamp(Date.now());
			controller.checkSoundMilestones(149_999); assert.equal(played.length, 0);
			controller.checkSoundMilestones(150_000); assert.equal(played.length, 1);
		} finally { controller.dispose(); }
	}
});

it("configures all sound thresholds with one ratio tuple", () => {
	const played: number[] = [];
	const controller = new CacheTimerController({ ttlMs: 600_000, soundMilestoneRatios: [0.25, 0.5, 0.75], soundPlayer: (_file, repeat = 1) => played.push(repeat) });
	try {
		controller.setLastContextTimestamp(Date.now());
		controller.checkSoundMilestones(149_999); assert.equal(played.length, 0);
		controller.checkSoundMilestones(150_000); assert.deepEqual(played, [1]);
		controller.checkSoundMilestones(300_000); assert.deepEqual(played, [1, 1]);
		controller.checkSoundMilestones(450_000); assert.deepEqual(played, [1, 1, 2]);
		controller.seedMilestones(450_000);
		controller.checkSoundMilestones(450_000); assert.equal(played.length, 3);
	} finally { controller.dispose(); }
});
