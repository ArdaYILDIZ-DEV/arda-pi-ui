import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildFooterLines, registerFooter, type FooterState } from "../footer.ts";
import { CacheTimerController } from "../cache-timer.ts";
import { GitInfoController } from "../git-info.ts";
import { stripAnsi } from "../palette.ts";

const state: FooterState = {
	model: "Grok 4.7 (low)",
	cwd: "/home/example/pi-ter-ws",
	git: "main +5",
	context: { tokens: 75_500, contextWindow: 500_000, percent: 15.1 },
	cacheHitRate: 78,
	cacheTimer: "ttl 1dk 47sn / 5dk",
	cacheExpired: false,
	statuses: new Map(),
};

const paint = { accent: (s: string) => s, muted: (s: string) => s, warning: (s: string) => s };

function mountFooter(entries: unknown[], branch = "main", git?: GitInfoController,
	theme: Pick<Theme, "fg"> & Partial<Pick<Theme, "appearance" | "getColorMode">> = { fg: (_color, text) => text }, cache?: CacheTimerController) {
	let component: { render(width: number): string[]; dispose(): void } | undefined;
	let start: Function | undefined;
	const ctx = {
		hasUI: true, cwd: "/tmp/project", model: { id: "test", name: "Test model" },
		getContextUsage: () => state.context,
		sessionManager: { getSessionId: () => "session", getLeafId: () => "leaf", getEntries: () => entries, getBranch: () => entries },
		ui: { setWidget: () => {}, setFooter: (factory: Function) => {
			component = factory({ requestRender: () => {} }, theme, {
				getGitBranch: () => branch, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
			});
		} },
	} as unknown as ExtensionContext;
	registerFooter({ on: (_name: string, handler: Function) => { start = handler; } } as unknown as ExtensionAPI, { git, cache });
	start!({}, ctx);
	assert.ok(component);
	return component;
}

describe("minimal footer", () => {
	it("orders model, folder, git, context, cache and TTL on one line", () => {
		assert.deepEqual(buildFooterLines(state, 160, paint), [
			"Grok 4.7 (low) | pi-ter-ws | main +5 | 75.5k / 500k | cache read 78% | ttl 1dk 47sn / 5dk",
		]);
	});

	it("smoothly colors the live TTL from yellow at three minutes to fixed red after five", (t) => {
		const now = 1_000_000;
		t.mock.method(Date, "now", () => now);
		const cache = new CacheTimerController({ soundEnabled: false });
		const component = mountFooter([], "main", undefined, {
			fg: (_role, text) => text, appearance: "dark", getColorMode: () => "truecolor",
		}, cache);
		const colorAt = (elapsedMs: number): number[] => {
			cache.setLastContextTimestamp(now - elapsedMs);
			const row = component.render(160)[0];
			const match = row.match(/\x1b\[38;2;(\d+);(\d+);(\d+)midle /);
			assert.ok(match, `TTL must have an RGB color at ${elapsedMs}ms`);
			return match.slice(1).map(Number);
		};
		try {
			assert.deepEqual(colorAt(180_000), [255, 193, 7]);
			assert.deepEqual(colorAt(240_000), [240, 105, 35]);
			let previous = colorAt(180_000);
			for (let elapsedMs = 181_000; elapsedMs <= 300_000; elapsedMs += 1000) {
				const current = colorAt(elapsedMs);
				assert.ok(current[1] <= previous[1], "green decreases toward red");
				assert.ok(current.every((channel, i) => Math.abs(channel - previous[i]) <= 4), "no abrupt color jumps");
				previous = current;
			}
			assert.deepEqual(colorAt(300_000), [140, 18, 18]);
			assert.deepEqual(colorAt(360_000), colorAt(300_000));
		} finally {
			component.dispose();
			cache.dispose();
		}
	});

	it("honors light backgrounds and the host's 256-color encoding for TTL", (t) => {
		t.mock.method(Date, "now", () => 1_000_000);
		const cache = new CacheTimerController({ soundEnabled: false });
		let mode: "truecolor" | "256color" = "truecolor";
		const component = mountFooter([], "main", undefined, {
			fg: (_role, text) => text, appearance: "light", getColorMode: () => mode,
		}, cache);
		try {
			cache.setLastContextTimestamp(820_000);
			assert.ok(component.render(160)[0].includes("\x1b[38;2;205;130;0midle "));
			cache.setLastContextTimestamp(700_000);
			assert.ok(component.render(160)[0].includes("\x1b[38;2;105;15;15midle "));
			mode = "256color";
			assert.match(component.render(160)[0], /\x1b\[38;5;\d+midle /);
		} finally {
			component.dispose();
			cache.dispose();
		}
	});

	it("shows a fresh TTL during processing rather than the previous expired request", (t) => {
		t.mock.method(Date, "now", () => 1_000_000);
		const cache = new CacheTimerController({ soundEnabled: false });
		cache.setLastContextTimestamp(640_000);
		const component = mountFooter([], "main", undefined, {
			fg: (_role, text) => text, appearance: "dark", getColorMode: () => "truecolor",
		}, cache);
		try {
			cache.handleAgentStart({ hasUI: false } as Parameters<CacheTimerController["handleAgentStart"]>[0]);
			const row = component.render(160)[0];
			assert.ok(row.includes("\x1b[38;2;78;186;101midle 0sn / 5dk"));
		} finally {
			component.dispose();
			cache.dispose();
		}
	});

	it("falls back safely when the host theme painter throws or returns invalid text", () => {
		for (const fg of [() => { throw new Error("theme unavailable"); }, () => undefined]) {
			const component = mountFooter([], "main", undefined, { fg } as unknown as Pick<Theme, "fg">);
			try {
				assert.doesNotThrow(() => component.render(160));
				assert.ok(stripAnsi(component.render(160)[0]).includes("Test model"));
			} finally {
				component.dispose();
			}
		}
	});

	it("right-aligns the session price, reserving space even on narrow terminals", () => {
		for (const width of [12, 40, 160]) {
			const lines = buildFooterLines({ ...state, cost: 0.123 }, width, paint);
			assert.ok(lines[0].endsWith("$0.123 est"));
			assert.equal(visibleWidth(lines[0]), width);
		}
		const lines = buildFooterLines({ ...state, cost: 2.125, statuses: new Map([["usage-ledger", "$601.66 est"]]) }, 160, paint);
		assert.ok(lines[0].endsWith("$2.13 est"));
		assert.equal(lines[1], "$601.66 est");
	});

	it("drops whole optional segments and preserves context and price on narrow rows", () => {
		const data = { ...state, model: "GPT-6.1 Sol (high)", cwd: "/tmp/arda-pi-ui", cost: 0.123 };
		const medium = buildFooterLines(data, 80, paint)[0];
		assert.ok(medium.includes("75.5k / 500k"));
		assert.ok(!medium.includes("cache ") || medium.includes("cache read 78%"));
		assert.ok(!medium.includes("ttl ") || medium.includes(state.cacheTimer));
		const narrow = buildFooterLines(data, 40, paint)[0];
		assert.ok(narrow.includes("75.5k / 500k"));
		assert.ok(narrow.endsWith("$0.123 est"));
		assert.ok(!narrow.includes("arda-pi"));
	});

	it("keeps context percentage instead of a model fragment when only a few columns remain", () => {
		for (const width of [15, 16, 17, 18]) {
			const line = buildFooterLines({ ...state, cost: 0.123 }, width, paint)[0];
			assert.ok(line.includes("15%"), line);
			assert.ok(line.endsWith("$0.123 est"), line);
			assert.ok(visibleWidth(line) <= width);
		}
	});

	it("omits unknown latest cache usage instead of crashing or reusing an older value", () => {
		const component = mountFooter([
			{ type: "message", message: { role: "assistant", usage: { input: 22, cacheRead: 78, cacheWrite: 0, cost: { total: 0.1 } } } },
			{ type: "message", message: { role: "assistant", content: [] } },
		]);
		assert.doesNotThrow(() => component.render(160));
		const line = stripAnsi(component.render(160)[0]);
		assert.ok(!line.includes("cache "));
		assert.ok(line.endsWith("$? est"));
		component.dispose();
	});

	it("keeps detached HEAD changes visible without borrowing a named branch's stale count", async () => {
		let branch = "(detached)";
		const git = new GitInfoController(async () => ({
			stdout: `# branch.oid abc123\0# branch.head ${branch}\0? one.ts\0? two.ts\0`, code: 0,
		}));
		await git.refresh("/tmp/project");
		const component = mountFooter([], "detached", git);
		assert.ok(stripAnsi(component.render(160)[0]).includes("detached@abc123 +2"));
		component.dispose();
		branch = "main";
		await git.refresh("/tmp/project");
		const stale = mountFooter([], "detached", git);
		assert.ok(!stripAnsi(stale.render(160)[0]).includes("+2"));
		stale.dispose();
	});

	it("labels missing and sub-millidollar prices without inventing a zero charge", () => {
		assert.ok(buildFooterLines({ ...state, cost: null }, 160, paint)[0].endsWith("$? est"));
		assert.ok(buildFooterLines({ ...state, cost: 0.00001 }, 160, paint)[0].endsWith("<$0.001 est"));
		for (const cost of [NaN, Infinity, -1]) {
			assert.ok(buildFooterLines({ ...state, cost }, 160, paint)[0].endsWith("$? est"));
		}
	});

	it("places all extension statuses below without changing their source data", () => {
		const statuses = new Map([
			["usage-ledger", "Σ5422.6M · $601.66 est"],
			["codex", "\x1b[31mcodex 100% ↻ 3h24m 83% ↻ 6d1h\x1b[0m"],
			["strict", "strict"],
		]);
		const before = Array.from(statuses);
		const lines = buildFooterLines({ ...state, statuses }, 160, paint);
		assert.equal(lines.length, 2);
		assert.equal(lines[1], "codex 100% ↻ 3h24m 83% ↻ 6d1h | strict | Σ5422.6M · $601.66 est");
		assert.deepEqual(Array.from(statuses), before);
	});

	it("keeps quota and cost data readable at narrow widths with Unicode folders", () => {
		for (const width of [1, 12, 40, 80]) {
			const lines = buildFooterLines({ ...state, cwd: "/tmp/项目", statuses: new Map([
				["codex", "codex 100% 83%"], ["usage-ledger", "Σ5422.6M · $601.66 est"],
			]) }, width, paint);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			if (width >= 40) assert.ok(lines.slice(1).join(" ").includes("$601.66 est"));
		}
	});

	it("does not invent context or cache values when usage is unknown", () => {
		const lines = buildFooterLines({ ...state, git: "", context: undefined, cacheHitRate: undefined, cacheTimer: "" }, 160, paint);
		assert.equal(lines[0], "Grok 4.7 (low) | pi-ter-ws | ? / ?");
	});

	it("strips terminal controls and multiline data from every external field", () => {
		const lines = buildFooterLines({ ...state, model: "model\x1b]2;spoof\x07\nname", cwd: "/tmp/project\x1b[2J", git: "main\r\n+5", statuses: new Map([["bad", "\x1b[31mquota\x1b[0m\n100%\x07"]]) }, 160, paint);
		assert.ok(lines.every((line) => !/[\x00-\x1f\x7f]/.test(line)));
		assert.ok(lines[1].includes("quota 100%"));
	});

	it("uses the default Claude accent without preserving foreign status colors", () => {
		const lines = buildFooterLines({ ...state, statuses: new Map([["quota", "\x1b[31mcodex 100%\x1b[0m"]]) }, 160);
		assert.ok(lines[0].includes("\x1b[38;2;215;119;87m"));
		assert.ok(!lines[1].includes("\x1b[31m"));
		assert.equal(stripAnsi(lines[1]), "codex 100%");
	});

	it("uses the active theme accent rather than a fixed orange", () => {
		let color = "215;119;87";
		const themed = { fg: (role: string, text: string) => role === "accent" ? `\x1b[38;2;${color}m${text}\x1b[39m` : text };
		const component = mountFooter([], "main", undefined, themed);
		const first = component.render(160)[0];
		assert.ok(first.includes("\x1b[38;2;215;119;87m"));
		assert.ok(!first.includes("\x1b[38;2;205;151;112m"));
		color = "1;2;3";
		assert.ok(component.render(160)[0].includes("\x1b[38;2;1;2;3m"));
		component.dispose();
	});

	it("installs through the footer API, reads changing data and removes only its own widget", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		let component: { render(width: number): string[]; dispose(): void } | undefined;
		let renders = 0;
		let unsubscribed = 0;
		const widgets: unknown[][] = [];
		const statuses = new Map([["codex", "codex 100%"]]);
		const cache = new CacheTimerController({ soundEnabled: false });
		cache.setLastContextTimestamp(Date.now());
		const entries: unknown[] = [{ type: "message", message: { role: "assistant", usage: { input: 22, cacheRead: 78, cacheWrite: 0, cost: { total: 0.1 } } } }];
		let leaf = "leaf";
		let contextUsage: FooterState["context"] = state.context;
		const currentTheme = {
			name: "dark", accent: "215;119;87",
			fg: (role: string, text: string) => role === "accent" ? `\x1b[38;2;${currentTheme.accent}m${text}\x1b[39m` : text,
		};
		const ctx = {
			hasUI: true, cwd: "/tmp/project", model: { name: "Test model", id: "test", reasoning: true, contextWindow: 500_000 }, thinkingLevel: "low",
			getContextUsage: () => contextUsage,
			sessionManager: { getLeafId: () => leaf, getSessionId: () => "session", getEntries: () => entries, getBranch: () => entries },
			ui: { theme: currentTheme, setWidget: (...args: unknown[]) => widgets.push(args), setFooter: (factory: Function) => {
				component = factory({ requestRender: () => renders++ }, { fg: (_color: string, text: string) => text }, {
					getGitBranch: () => "main", getExtensionStatuses: () => statuses,
					onBranchChange: () => () => unsubscribed++,
				});
			} },
		} as unknown as ExtensionContext;
		registerFooter({ getThinkingLevel: () => "low", on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler) } as unknown as ExtensionAPI, { cache });
		handlers.get("session_start")!({}, ctx);
		assert.ok(component);
		assert.ok(widgets.every(([key, content]) => key === "cache-timer" && content === undefined));
		assert.ok(stripAnsi(component.render(160)[0]).startsWith("Test model (low) | project | main"));
		assert.ok(stripAnsi(component.render(160)[0]).includes("cache read 78%"));
		assert.ok(stripAnsi(component.render(160)[0]).endsWith("$0.100 est"));
		entries.push(
			{ type: "usage", usage: { cost: { total: 0.2 } } },
			{ type: "message", message: { role: "toolResult", usage: { cost: { total: 0.3 } } } },
			{ type: "branch_summary", usage: { cost: { total: 0.4 } } },
		);
		leaf = "auxiliary-usage";
		assert.ok(stripAnsi(component.render(160)[0]).endsWith("$1.00 est"));
		statuses.set("codex", "codex 95%");
		assert.equal(stripAnsi(component.render(160)[1]), "codex 95%");
		cache.repaint(ctx);
		assert.ok(renders > 0);
		cache.setVisible(false, ctx);
		assert.ok(!stripAnsi(component.render(160)[0]).includes("ttl "));
		entries.push({ type: "compaction", usage: { cost: { total: 0.5 } } });
		leaf = "after-compaction";
		contextUsage = undefined;
		assert.ok(!stripAnsi(component.render(160)[0]).includes("cache read 78%"));
		assert.ok(stripAnsi(component.render(160)[0]).includes("? / 500k"));
		assert.ok(stripAnsi(component.render(160)[0]).endsWith("$1.50 est"));
		entries.push({ type: "usage", usage: {} });
		leaf = "unknown-price";
		assert.ok(stripAnsi(component.render(160)[0]).endsWith("$? est"));
		currentTheme.name = "light";
		currentTheme.accent = "184;78;45";
		assert.ok(component.render(160)[0].includes("\x1b[38;2;184;78;45m"));
		component.dispose();
		component.dispose();
		assert.equal(unsubscribed, 1);
		cache.dispose();
	});

	it("leaves headless mode and hosts without setFooter alone", () => {
		const handlers = new Map<string, Function>();
		registerFooter({ on: (name: string, handler: Function) => handlers.set(name, handler) } as unknown as ExtensionAPI);
		assert.doesNotThrow(() => handlers.get("session_start")!({}, { hasUI: false }));
		assert.doesNotThrow(() => handlers.get("session_start")!({}, { hasUI: true, ui: {} }));
	});
});
