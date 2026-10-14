import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCacheTimer } from "../cache-timer.ts";
import { registerFooter } from "../footer.ts";
import { stripAnsi, visibleWidth } from "../palette.ts";

it("integrates real usage, request ages, warm costs and model invalidation without sending requests", async (t) => {
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);
	const handlers = new Map<string, Function[]>();
	let component: { render(width: number): string[]; dispose(): void } | undefined;
	const entries: unknown[] = [];
	let branchReads = 0;
	let settingsReads = 0;
	const pi = {
		on: (event: string, handler: Function) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
		registerCommand: () => {}, getThinkingLevel: () => "off",
		getSettings: () => { settingsReads++; return {}; },
	} as unknown as ExtensionAPI;
	const theme = { fg: (_role: string, value: string) => value };
	const ctx = {
		hasUI: true, cwd: "/tmp/isolated-ui-test", mode: "tui",
		model: { provider: "anthropic", id: "claude-test", name: "Claude test", api: "anthropic-messages", promptCache: { short: 300, long: 3600 }, contextWindow: 200_000 },
		getContextUsage: () => ({ tokens: 1000, percent: 0.5, contextWindow: 200_000 }),
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => { branchReads++; return entries; },
			getLeafId: () => String(entries.length), getSessionId: () => "isolated-test",
		},
		ui: { theme, setWidget: () => {}, setFooter: (factory: Function) => {
			component = factory({ requestRender: () => {} }, theme, { getGitBranch: () => "", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} });
		} },
	} as unknown as ExtensionContext;
	const controller = registerCacheTimer(pi, { soundEnabled: false });
	registerFooter(pi, { cache: controller });
	const emit = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	const row = () => stripAnsi(component!.render(180)[0]);
	try {
		await emit("session_start");
		assert.ok(!row().includes("age "));
		await emit("agent_start");
		await emit("before_provider_request", { payload: { cache_control: { type: "ephemeral" } } });
		const message = { role: "assistant", provider: "anthropic", model: "claude-test", api: "anthropic-messages", stopReason: "stop", timestamp: now, usage: { input: 100, cacheRead: 700, cacheWrite: 200, cost: { total: 0.1 } } };
		now += 240_000;
		await emit("message_end", { message });
		entries.push({ type: "message", message });
		await emit("turn_end"); await emit("agent_settled");
		assert.match(row(), /cache read 70% \| age 4dk 0sn \/ ~5dk/);
		assert.ok(!row().includes("ttl 0sn"));
		await emit("agent_start");
		assert.match(row(), /age 4dk 0sn \/ ~5dk/);
		assert.match(controller.getStatusSummary(), /700 read, 200 write, 100 uncached/);
		const branchReadCount = branchReads;
		for (let i = 0; i < 10; i++) component!.render(180);
		assert.ok(branchReads - branchReadCount <= 1, "unchanged rendering does not repeatedly scan the session branch");
		await emit("agent_settled");
		now += 30_000;
		entries.push({ type: "usage", kind: "cache_warm", provider: "anthropic", model: "claude-test", timestamp: new Date(now).toISOString(), usage: { input: 0, cacheRead: 1000, cacheWrite: 0, cost: { total: 0.02 } } });
		now += 10_000;
		assert.match(row(), /cache read 70% \| warm age ~10sn \/ ~5dk\*/);
		assert.ok(row().endsWith("$0.120 est"));
		assert.match(controller.getStatusSummary(), /Pi warm: 1000 read/);
		for (const width of [1, 15, 30, 60, 100]) assert.ok(visibleWidth(component!.render(width)[0]) <= width);
		ctx.model = { ...ctx.model!, provider: "xai", id: "grok-test", api: "openai-completions", promptCache: undefined };
		await emit("model_select");
		assert.ok(!row().includes("cache read 70%"));
		assert.ok(!row().includes("age "));
		assert.equal(settingsReads, 0, "extension does not enable or rewrite cache warming settings");
		await emit("session_shutdown");
		assert.equal(controller.getState().hasTimer, false);
	} finally {
		component?.dispose();
		controller.dispose();
	}
});
