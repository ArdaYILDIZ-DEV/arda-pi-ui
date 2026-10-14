import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	buildCacheTimerLine,
	type CacheTimerPaint,
	CacheTimerController,
	colorizeRgb,
	DARK_CACHE_STOPS,
	formatCacheElapsed,
	formatCacheRemaining,
	getCacheColor,
	getCacheTtlRatio,
	interpolateRgb,
	LIGHT_CACHE_STOPS,
	registerCacheTimer,
	resolveSoundPath,
	CACHE_SOUND_MILESTONES,
	rgbToAnsi,
	type UiCtx,
} from "../cache-timer.ts";
import { rgb, stripAnsi, visibleWidth } from "../palette.ts";

function createMockPaint(scheme: "dark" | "light" = "dark"): CacheTimerPaint {
	return {
		colorize: (text, color) => colorizeRgb(text, color, "truecolor"),
		dim: (text) => `\x1b[2m${text}\x1b[22m`,
		accent: (text) => `\x1b[38;2;215;119;87m${text}\x1b[39m`,
		red: (text) => `\x1b[38;2;255;107;128m${text}\x1b[39m`,
		scheme,
		colorMode: "truecolor",
	};
}

describe("cache timer pure functions", () => {
	describe("formatCacheElapsed", () => {
		it("formats seconds correctly", () => {
			assert.equal(formatCacheElapsed(0), "0sn");
			assert.equal(formatCacheElapsed(1000), "1sn");
			assert.equal(formatCacheElapsed(45_000), "45sn");
			assert.equal(formatCacheElapsed(59_999), "59sn");
		});

		it("formats minutes and seconds correctly", () => {
			assert.equal(formatCacheElapsed(60_000), "1dk 0sn");
			assert.equal(formatCacheElapsed(75_000), "1dk 15sn");
			assert.equal(formatCacheElapsed(240_000), "4dk 0sn");
			assert.equal(formatCacheElapsed(299_000), "4dk 59sn");
		});

		it("formats hours, minutes, and seconds correctly", () => {
			assert.equal(formatCacheElapsed(3600_000), "1sa 0dk 0sn");
			assert.equal(formatCacheElapsed(3665_000), "1sa 1dk 5sn");
		});

		it("safely handles edge cases (negative, NaN, Infinity)", () => {
			assert.equal(formatCacheElapsed(-500), "0sn");
			assert.equal(formatCacheElapsed(NaN as any), "0sn");
			assert.equal(formatCacheElapsed(Infinity as any), "0sn");
		});
	});

	describe("formatCacheRemaining", () => {
		it("formats remaining time until 5 minutes (300s)", () => {
			assert.equal(formatCacheRemaining(0, 300_000), "5dk 0sn");
			assert.equal(formatCacheRemaining(45_000, 300_000), "4dk 15sn");
			assert.equal(formatCacheRemaining(120_000, 300_000), "3dk 0sn");
			assert.equal(formatCacheRemaining(255_000, 300_000), "45sn");
			assert.equal(formatCacheRemaining(299_000, 300_000), "1sn");
		});

		it("clamps to 0sn when expired", () => {
			assert.equal(formatCacheRemaining(300_000, 300_000), "0sn");
			assert.equal(formatCacheRemaining(350_000, 300_000), "0sn");
		});

		it("safely handles edge cases", () => {
			assert.equal(formatCacheRemaining(-1000, 300_000), "5dk 0sn");
			assert.equal(formatCacheRemaining(NaN as any, 300_000), "5dk 0sn");
		});
	});

	describe("getCacheTtlRatio", () => {
		it("computes ratio from 0.0 to 1.0", () => {
			assert.equal(getCacheTtlRatio(0, 300_000), 0);
			assert.equal(getCacheTtlRatio(150_000, 300_000), 0.5);
			assert.equal(getCacheTtlRatio(300_000, 300_000), 1.0);
		});

		it("clamps values exceeding TTL to 1.0", () => {
			assert.equal(getCacheTtlRatio(400_000, 300_000), 1.0);
		});

		it("clamps negative values to 0.0", () => {
			assert.equal(getCacheTtlRatio(-5000, 300_000), 0.0);
			assert.equal(getCacheTtlRatio(NaN as any, 300_000), 0.0);
		});
	});

	describe("interpolateRgb & getCacheColor", () => {
		it("interpolates between two colors accurately", () => {
			const c1 = rgb(0, 100, 200);
			const c2 = rgb(100, 200, 0);
			const mid = interpolateRgb(c1, c2, 0.5);
			assert.equal(mid.r, 50);
			assert.equal(mid.g, 150);
			assert.equal(mid.b, 100);
		});

		it("returns fresh green at ratio 0.0 for dark scheme", () => {
			const col = getCacheColor(0.0, "dark");
			assert.equal(col.r, DARK_CACHE_STOPS[0]!.r);
			assert.equal(col.g, DARK_CACHE_STOPS[0]!.g);
			assert.equal(col.b, DARK_CACHE_STOPS[0]!.b);
		});

		it("transitions to amber yellow at ratio 0.60 (3 minutes)", () => {
			const col = getCacheColor(0.6, "dark");
			assert.equal(col.r, 255);
			assert.equal(col.g, 193);
			assert.equal(col.b, 7);
		});

		it("transitions towards red and darkens into deep crimson red at 5 minutes", () => {
			const nearEnd = getCacheColor(0.92, "dark"); // 4m 36s - bright danger red
			assert.equal(nearEnd.r, 235);
			assert.equal(nearEnd.g, 50);
			assert.equal(nearEnd.b, 50);

			const at5min = getCacheColor(1.0, "dark"); // 5m - deep dark crimson red
			assert.equal(at5min.r, 140);
			assert.equal(at5min.g, 18);
			assert.equal(at5min.b, 18);

			// Verifies user requirement: "5 dakikaya yaklaştıkça rengi koyulaşsın kırmızıya doğru"
			// Red luminance drops from 235 to 140, producing a darker, deeper red.
			assert.ok(at5min.r < nearEnd.r, "red value darkens as 5 minutes approaches");
		});

		it("handles light scheme colors", () => {
			const lightStart = getCacheColor(0.0, "light");
			assert.equal(lightStart.r, LIGHT_CACHE_STOPS[0]!.r);
			const lightEnd = getCacheColor(1.0, "light");
			assert.equal(lightEnd.r, LIGHT_CACHE_STOPS[LIGHT_CACHE_STOPS.length - 1]!.r);
		});
	});

	describe("rgbToAnsi & colorizeRgb", () => {
		it("generates 24-bit truecolor escape sequence", () => {
			const seq = rgbToAnsi(78, 186, 101, "truecolor");
			assert.equal(seq, "\x1b[38;2;78;186;101m");
		});

		it("generates 256color escape sequence", () => {
			const seq = rgbToAnsi(255, 0, 0, "256color");
			assert.ok(seq.startsWith("\x1b[38;5;"));
		});

		it("colorizes text and terminates with reset", () => {
			const text = colorizeRgb("test", rgb(255, 0, 0), "truecolor");
			assert.equal(text, "\x1b[38;2;255;0;0mtest\x1b[39m");
		});
	});
});

describe("buildCacheTimerLine", () => {
	const paint = createMockPaint("dark");

	it("returns empty string when hasContext is false", () => {
		const line = buildCacheTimerLine(
			{
				elapsedMs: 0,
				ttlMs: 300_000,
				columns: 80,
				hasContext: false,
				isProcessing: false,
			},
			paint,
		);
		assert.equal(line, "");
	});

	it("renders 0sn / 5dk right-aligned during in-progress LLM turn", () => {
		const line = buildCacheTimerLine(
			{
				elapsedMs: 5000,
				ttlMs: 300_000,
				columns: 80,
				hasContext: true,
				isProcessing: true,
			},
			paint,
		);
		const plain = stripAnsi(line);
		assert.ok(plain.endsWith("0sn / 5dk"));
		assert.ok(plain.startsWith(" "));
		assert.equal(visibleWidth(plain), 78);
	});

	it("renders right-aligned active cache status (36sn / 5dk)", () => {
		const line = buildCacheTimerLine(
			{
				elapsedMs: 36_000,
				ttlMs: 300_000,
				columns: 80,
				hasContext: true,
				isProcessing: false,
			},
			paint,
		);
		const plain = stripAnsi(line);
		assert.ok(plain.endsWith("36sn / 5dk"));
		assert.ok(plain.startsWith(" "));
		assert.equal(visibleWidth(plain), 78);
	});

	it("renders minutes and seconds accurately (1dk 15sn / 5dk)", () => {
		const line = buildCacheTimerLine(
			{
				elapsedMs: 75_000,
				ttlMs: 300_000,
				columns: 80,
				hasContext: true,
				isProcessing: false,
			},
			paint,
		);
		const plain = stripAnsi(line);
		assert.ok(plain.endsWith("1dk 15sn / 5dk"));
		assert.equal(visibleWidth(plain), 78);
	});

	it("renders expired status (5dk 20sn / 5dk) right-aligned", () => {
		const line = buildCacheTimerLine(
			{
				elapsedMs: 320_000, // 5m 20s
				ttlMs: 300_000,
				columns: 80,
				hasContext: true,
				isProcessing: false,
			},
			paint,
		);
		const plain = stripAnsi(line);
		assert.ok(plain.endsWith("5dk 20sn / 5dk"));
		assert.equal(visibleWidth(plain), 78);
	});

	it("renders git summary on the left and TTL badge on the right when space allows", () => {
		const line = buildCacheTimerLine(
			{
				elapsedMs: 36_000,
				ttlMs: 300_000,
				columns: 80,
				hasContext: true,
				isProcessing: false,
				gitSummary: "main* · 2 dosya",
			},
			paint,
		);
		const plain = stripAnsi(line);
		assert.ok(plain.startsWith("main* · 2 dosya"));
		assert.ok(plain.endsWith("36sn / 5dk"));
		assert.equal(visibleWidth(line), 78);
	});

	it("renders git summary even before first prompt when context is false", () => {
		const line = buildCacheTimerLine(
			{
				elapsedMs: 0,
				ttlMs: 300_000,
				columns: 80,
				hasContext: false,
				isProcessing: false,
				gitSummary: "main · clean",
			},
			paint,
		);
		const plain = stripAnsi(line);
		assert.equal(plain, "main · clean");
	});

	it("progressively truncates or drops git summary on narrow viewports", () => {
		const cols = 28;
		const line = buildCacheTimerLine(
			{
				elapsedMs: 36_000,
				ttlMs: 300_000,
				columns: cols,
				hasContext: true,
				isProcessing: false,
				gitSummary: "feature-long-branch-name* · 5 dosya",
			},
			paint,
		);
		const visW = visibleWidth(line);
		assert.ok(visW <= cols - 2);
		const plain = stripAnsi(line);
		assert.ok(plain.endsWith("36sn / 5dk"));
	});

	it("progressively collapses layout on narrow viewports without exceeding width", () => {
		const widths = [120, 80, 60, 45, 30, 20, 10, 5, 2, 1];
		for (const cols of widths) {
			const line = buildCacheTimerLine(
				{
					elapsedMs: 75_000,
					ttlMs: 300_000,
					columns: cols,
					hasContext: true,
					isProcessing: false,
				},
				paint,
			);
			const visW = visibleWidth(line);
			// Text component in Pi applies paddingX: 1 (max content width = cols - 2)
			const maxAllowed = Math.max(1, cols - 2);
			assert.ok(
				visW <= maxAllowed,
				`visible width ${visW} exceeds max allowed ${maxAllowed} at cols=${cols}`,
			);
		}
	});
});

describe("CacheTimerController lifecycle", () => {
	function createMockUi(): {
		ctx: UiCtx;
		widgets: Map<string, { content?: string[]; placement?: string }>;
		notified: string[];
	} {
		const widgets = new Map<string, { content?: string[]; placement?: string }>();
		const notified: string[] = [];
		const mockTheme = {
			name: "claude-code-dark",
			fg: (_token: string, text: string) => text,
			bg: (_token: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;

		const ctx = {
			hasUI: true,
			ui: {
				theme: mockTheme,
				setWidget: (key: string, content?: string[], opts?: any) => {
					if (content === undefined) {
						widgets.delete(key);
					} else {
						widgets.set(key, { content, placement: opts?.placement });
					}
				},
				notify: (msg: string) => {
					notified.push(msg);
				},
			},
		} as unknown as UiCtx;

		return {
			ctx,
			widgets,
			notified,
		};
	}

	it("does not create a background interval in headless mode", () => {
		const controller = new CacheTimerController({ soundEnabled: false });
		try {
			controller.handleAgentStart({ hasUI: false } as UiCtx);
			assert.equal(controller.getState().hasTimer, false);
			controller.handleAgentSettled({ hasUI: false } as UiCtx);
			assert.equal(controller.getState().hasTimer, false);
		} finally {
			controller.dispose();
		}
	});

	it("ticks against the current session UI rather than the context captured by the first interval", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const controller = new CacheTimerController({ soundEnabled: false });
		const first = createMockUi();
		const second = createMockUi();
		try {
			controller.handleAgentStart(first.ctx);
			controller.handleBeforeProviderRequest(first.ctx);
			controller.handleAgentSettled(second.ctx);
			first.widgets.clear();
			second.widgets.clear();
			t.mock.timers.tick(1000);
			assert.equal(first.widgets.size, 0);
			assert.equal(second.widgets.has("cache-timer"), true);
		} finally {
			controller.dispose();
		}
	});

	it("reports a local reminder with the configured TTL, not a provider cache guarantee", (t) => {
		t.mock.method(Date, "now", () => 1_000_000);
		const controller = new CacheTimerController({ ttlMs: 60_000, soundEnabled: false });
		try {
			controller.setLastContextTimestamp(970_000);
			const active = controller.getStatusSummary();
			assert.ok(active.includes("1dk"));
			assert.ok(active.includes("yerel"));
			assert.ok(!active.includes("Cache hit aktif"));
			controller.setLastContextTimestamp(900_000);
			const expired = controller.getStatusSummary();
			assert.ok(expired.includes("1dk"));
			assert.ok(!expired.includes("5dk"));
			assert.ok(!expired.includes("Cache miss riski"));
			controller.handleAgentStart({ hasUI: false } as UiCtx);
			assert.ok(controller.getStatusSummary().includes("İşleniyor"));
		} finally {
			controller.dispose();
		}
	});

	it("rejects non-finite and non-positive TTLs consistently with the pure helpers", () => {
		for (const ttlMs of [Infinity, -Infinity, NaN, 0, -1]) {
			const controller = new CacheTimerController({ ttlMs, soundEnabled: false });
			try {
				assert.equal(controller.getTtlMs(), 300_000);
				controller.setLastContextTimestamp(Date.now() - 360_000);
				assert.equal(controller.getState().isExpired, true);
			} finally {
				controller.dispose();
			}
		}
	});

	it("initializes without active widget on a brand new session", () => {
		const controller = new CacheTimerController();
		const mock = createMockUi();
		controller.handleSessionStart({
			...mock.ctx,
			sessionManager: { getEntries: () => [] },
		});

		assert.equal(controller.getLastContextTimestamp(), null);
		assert.equal(mock.widgets.has("cache-timer"), false);
		controller.dispose();
	});

	it("seeds lastContextTimestamp from existing session history on resume", () => {
		const controller = new CacheTimerController();
		const mock = createMockUi();
		const sampleTime = "2026-09-01T12:00:00.000Z";
		const entries = [
			{ type: "session", timestamp: "2026-09-01T11:59:00.000Z" },
			{ type: "message", timestamp: sampleTime, message: { role: "assistant" } },
		];
		controller.handleSessionStart({
			...mock.ctx,
			sessionManager: { getEntries: () => entries },
		});

		assert.equal(controller.getLastContextTimestamp(), Date.parse(sampleTime));
		assert.equal(mock.widgets.has("cache-timer"), true);
		const widget = mock.widgets.get("cache-timer");
		assert.equal(widget?.placement, "belowEditor");
		controller.dispose();
	});

	it("handles agent_start -> before_provider_request -> message_end -> agent_settled lifecycle", () => {
		const controller = new CacheTimerController();
		const mock = createMockUi();

		controller.handleSessionStart({
			...mock.ctx,
			sessionManager: { getEntries: () => [] },
		});
		assert.equal(mock.widgets.has("cache-timer"), false);

		// Agent starts
		controller.handleAgentStart(mock.ctx);
		assert.equal(controller.getState().isProcessing, true);
		assert.equal(mock.widgets.has("cache-timer"), true);
		const processingLine = stripAnsi(
			mock.widgets.get("cache-timer")!.content![0]!,
		);
		assert.ok(processingLine.endsWith("0sn / 5dk"));

		// Provider request
		controller.handleBeforeProviderRequest(mock.ctx);
		const t1 = controller.getLastContextTimestamp();
		assert.ok(typeof t1 === "number" && t1 > 0);

		// Assistant message end
		controller.handleMessageEnd(
			{
				type: "message_end",
				message: { role: "assistant" } as any,
			},
			mock.ctx,
		);

		// Agent settled
		controller.handleAgentSettled(mock.ctx);
		assert.equal(controller.getState().isProcessing, false);
		const settledLine = stripAnsi(mock.widgets.get("cache-timer")!.content![0]!);
		assert.ok(settledLine.endsWith("0sn / 5dk"));

		controller.dispose();
	});

	it("supports toggleVisibility and slash command toggling", () => {
		const controller = new CacheTimerController();
		const mock = createMockUi();
		controller.handleSessionStart({
			...mock.ctx,
			sessionManager: {
				getEntries: () => [
					{ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant" } },
				],
			},
		});

		assert.equal(mock.widgets.has("cache-timer"), true);

		// Toggle off
		const visible1 = controller.toggleVisibility(mock.ctx);
		assert.equal(visible1, false);
		assert.equal(mock.widgets.has("cache-timer"), false);

		// Toggle on
		const visible2 = controller.toggleVisibility(mock.ctx);
		assert.equal(visible2, true);
		assert.equal(mock.widgets.has("cache-timer"), true);

		controller.dispose();
	});

	it("cleans up timers and widgets cleanly on session_shutdown and dispose", () => {
		const controller = new CacheTimerController();
		const mock = createMockUi();
		controller.handleSessionStart({
			...mock.ctx,
			sessionManager: {
				getEntries: () => [
					{ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant" } },
				],
			},
		});

		assert.equal(controller.getState().hasTimer, true);
		controller.handleSessionShutdown(mock.ctx);
		assert.equal(controller.getState().hasTimer, false);
		assert.equal(mock.widgets.has("cache-timer"), false);

		controller.dispose();
		assert.equal(controller.getState().hasTimer, false);
	});

	it("registers handlers and slash command with pi ExtensionAPI", () => {
		const handlers = new Map<string, any[]>();
		const commands = new Map<string, any>();
		const mockPi = {
			on: (event: string, handler: any) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			registerCommand: (name: string, opts: any) => {
				commands.set(name, opts);
			},
		};

		const controller = registerCacheTimer(mockPi as any);
		assert.ok(controller instanceof CacheTimerController);
		assert.ok(handlers.has("session_start"));
		assert.ok(handlers.has("agent_start"));
		assert.ok(handlers.has("before_provider_request"));
		assert.ok(handlers.has("message_end"));
		assert.ok(handlers.has("turn_end"));
		assert.ok(handlers.has("agent_settled"));
		assert.ok(handlers.has("session_shutdown"));
		assert.ok(commands.has("cache"));

		controller.dispose();
	});

	it("supports audio notification toggle and slash commands", () => {
		const controller = new CacheTimerController();

		assert.equal(controller.isAudioEnabled(), true);
		assert.equal(controller.toggleSound(), false);
		assert.equal(controller.isAudioEnabled(), false);
		assert.equal(controller.toggleSound(), true);
		assert.equal(controller.isAudioEnabled(), true);

		controller.setSoundEnabled(false);
		assert.equal(controller.isAudioEnabled(), false);
		controller.setSoundEnabled(true);
		assert.equal(controller.isAudioEnabled(), true);

		controller.dispose();
	});
});

describe("Cache audio warning milestones & playback", () => {
	function createMockUi() {
		const widgets = new Map<string, { content?: string[]; placement?: string }>();
		const notified: string[] = [];
		const mockTheme = {
			name: "claude-code-dark",
			fg: (_token: string, text: string) => text,
			bg: (_token: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;

		const ctx = {
			hasUI: true,
			ui: {
				theme: mockTheme,
				setWidget: (key: string, content?: string[], opts?: any) => {
					if (content === undefined) {
						widgets.delete(key);
					} else {
						widgets.set(key, { content, placement: opts?.placement });
					}
				},
				notify: (msg: string) => {
					notified.push(msg);
				},
			},
		} as unknown as UiCtx;

		return { ctx, widgets, notified };
	}

	it("resolves sound files located in sounds/ directory", () => {
		const path3 = resolveSoundPath("3.mp3");
		const path4 = resolveSoundPath("4.mp3");
		assert.ok(path3 !== null && path3.endsWith("sounds/3.mp3"));
		assert.ok(path4 !== null && path4.endsWith("sounds/4.mp3"));

		assert.equal(resolveSoundPath("non-existent-sound.mp3"), null);
		assert.equal(resolveSoundPath(""), null);
	});

	it("defines correct milestone times and repeats", () => {
		assert.equal(CACHE_SOUND_MILESTONES.length, 3);
		// Half of five minutes: 150s, 3.mp3, once
		assert.equal(CACHE_SOUND_MILESTONES[0]!.elapsedMs, 150_000);
		assert.equal(CACHE_SOUND_MILESTONES[0]!.soundFile, "3.mp3");
		assert.equal(CACHE_SOUND_MILESTONES[0]!.repeat, 1);

		// 4. dakika: 240s, 4.mp3, 1 kez
		assert.equal(CACHE_SOUND_MILESTONES[1]!.elapsedMs, 240_000);
		assert.equal(CACHE_SOUND_MILESTONES[1]!.soundFile, "4.mp3");
		assert.equal(CACHE_SOUND_MILESTONES[1]!.repeat, 1);

		// 4.30. dakika: 270s, 4.mp3, 2 kez
		assert.equal(CACHE_SOUND_MILESTONES[2]!.elapsedMs, 270_000);
		assert.equal(CACHE_SOUND_MILESTONES[2]!.soundFile, "4.mp3");
		assert.equal(CACHE_SOUND_MILESTONES[2]!.repeat, 2);
	});

	it("triggers 2.30m (once), 4m (once), and 4.30m (twice) sequentially and idempotently", () => {
		const played: { file: string; repeat: number }[] = [];
		const controller = new CacheTimerController(300_000, {
			soundPlayer: (file, repeat = 1) => {
				played.push({ file, repeat });
			},
		});

		const now = 1_000_000_000;
		controller.setLastContextTimestamp(now);

		// At 2m 29s -> No sound
		controller.checkSoundMilestones(149_000);
		assert.equal(played.length, 0);

		// At 2m 30s -> 3.mp3 plays once
		controller.checkSoundMilestones(150_000);
		assert.equal(played.length, 1);
		assert.ok(played[0]!.file.endsWith("3.mp3"));
		assert.equal(played[0]!.repeat, 1);

		// At 2m 31s -> Still 1 play (no duplicate trigger)
		controller.checkSoundMilestones(151_000);
		assert.equal(played.length, 1);

		// At 3m 59s (239_000 ms) -> No additional sound
		controller.checkSoundMilestones(239_000);
		assert.equal(played.length, 1);

		// At 4m 00s (240_000 ms) -> 4.mp3 plays once
		controller.checkSoundMilestones(240_000);
		assert.equal(played.length, 2);
		assert.ok(played[1]!.file.endsWith("4.mp3"));
		assert.equal(played[1]!.repeat, 1);

		// At 4m 01s (241_000 ms) -> No duplicate trigger
		controller.checkSoundMilestones(241_000);
		assert.equal(played.length, 2);

		// At 4m 29s (269_000 ms) -> No additional sound
		controller.checkSoundMilestones(269_000);
		assert.equal(played.length, 2);

		// At 4m 30s (270_000 ms) -> 4.mp3 plays twice
		controller.checkSoundMilestones(270_000);
		assert.equal(played.length, 3);
		assert.ok(played[2]!.file.endsWith("4.mp3"));
		assert.equal(played[2]!.repeat, 2);

		// At 4m 31s (271_000 ms) -> No duplicate trigger
		controller.checkSoundMilestones(271_000);
		assert.equal(played.length, 3);

		controller.dispose();
	});

	it("suppresses sound when sound is disabled or agent is processing", () => {
		const played: { file: string; repeat: number }[] = [];
		const controller = new CacheTimerController(300_000, {
			soundEnabled: false,
			soundPlayer: (file, repeat = 1) => played.push({ file, repeat }),
		});

		controller.setLastContextTimestamp(Date.now());
		controller.checkSoundMilestones(180_000);
		controller.checkSoundMilestones(240_000);
		controller.checkSoundMilestones(270_000);
		assert.equal(played.length, 0);

		// Re-enable sound
		controller.setSoundEnabled(true);
		controller.checkSoundMilestones(180_000);
		assert.equal(played.length, 1);

		// If processing, suppress
		const mock = createMockUi();
		controller.handleAgentStart(mock.ctx);
		controller.checkSoundMilestones(240_000);
		assert.equal(played.length, 1); // Not incremented

		controller.dispose();
	});

	it("seeds already-passed milestones on resume so sounds do not blast on startup", () => {
		const played: { file: string; repeat: number }[] = [];
		const controller = new CacheTimerController(300_000, {
			soundPlayer: (file, repeat = 1) => played.push({ file, repeat }),
		});
		const mock = createMockUi();

		// Session resumed with last message 6 minutes (360s) ago
		const sixMinutesAgo = new Date(Date.now() - 360_000).toISOString();
		controller.handleSessionStart({
			...mock.ctx,
			sessionManager: {
				getEntries: () => [{ type: "message", timestamp: sixMinutesAgo, message: { role: "assistant" } }],
			},
		});

		// Check milestones for current elapsed (360s)
		controller.checkSoundMilestones(360_000);
		assert.equal(
			played.length,
			0,
			"No sound should play for already-expired historical session",
		);

		controller.dispose();
	});

	it("resets local reminder milestones only when a provider request starts", () => {
		const played: { file: string; repeat: number }[] = [];
		const controller = new CacheTimerController(300_000, {
			soundPlayer: (file, repeat = 1) => played.push({ file, repeat }),
		});
		const mock = createMockUi();

		controller.setLastContextTimestamp(Date.now());
		controller.checkSoundMilestones(180_000);
		assert.equal(played.length, 1);

		controller.handleAgentSettled(mock.ctx);
		controller.checkSoundMilestones(180_000);
		assert.equal(played.length, 1, "settlement is not cache activity");
		controller.handleBeforeProviderRequest(mock.ctx);
		controller.handleAgentSettled(mock.ctx);
		controller.checkSoundMilestones(180_000);
		assert.equal(played.length, 2);

		controller.dispose();
	});

	it("handles slash command /cache sound toggles via registered command", async () => {
		type HandlerFn = (args: string, ctx: any) => Promise<void>;
		let registeredHandler: HandlerFn | undefined;
		const mockPi = {
			on: () => {},
			registerCommand: (name: string, opts: any) => {
				if (name === "cache") registeredHandler = opts.handler;
			},
		};

		const controller = registerCacheTimer(mockPi as any);
		assert.ok(registeredHandler !== undefined);
		const handler: HandlerFn = registeredHandler;

		const mock = createMockUi();
		// Test toggle off
		await handler("sound toggle", mock.ctx);
		assert.equal(controller.isAudioEnabled(), false);
		assert.ok(mock.notified.pop()?.includes("kapalı"));

		// Test toggle on
		await handler("ses toggle", mock.ctx);
		assert.equal(controller.isAudioEnabled(), true);
		assert.ok(mock.notified.pop()?.includes("açık"));

		// Test direct off
		await handler("sound off", mock.ctx);
		assert.equal(controller.isAudioEnabled(), false);
		assert.ok(mock.notified.pop()?.includes("kapalı"));

		// Test direct on
		await handler("sound on", mock.ctx);
		assert.equal(controller.isAudioEnabled(), true);
		assert.ok(mock.notified.pop()?.includes("açık"));

		// Test status summary includes sound
		await handler("", mock.ctx);
		const summary = mock.notified.pop()!;
		assert.ok(summary.includes("Sesli uyarı: açık"));

		controller.dispose();
	});

	it("/cache sound test plays the milestone file without real audio", async () => {
		type HandlerFn = (args: string, ctx: any) => Promise<void>;
		let registeredHandler: HandlerFn | undefined;
		const mockPi = {
			on: () => {},
			registerCommand: (name: string, opts: any) => {
				if (name === "cache") registeredHandler = opts.handler;
			},
		};

		const controller = registerCacheTimer(mockPi as any);
		const played: { file: string; repeat: number }[] = [];
		controller.setSoundPlayer((file, repeat = 1) =>
			played.push({ file, repeat }),
		);
		const handler: HandlerFn = registeredHandler!;
		const mock = createMockUi();

		await handler("sound test", mock.ctx);
		assert.equal(played.length, 1);
		assert.ok(played[0]!.file.endsWith("sounds/3.mp3"));
		assert.equal(played[0]!.repeat, 1);
		assert.ok(mock.notified.pop()?.includes("Ses testi"));

		controller.dispose();
	});

	it("repaint still fires milestones when widget rendering throws", () => {
		const played: { file: string; repeat: number }[] = [];
		const controller = new CacheTimerController(300_000, {
			soundPlayer: (file, repeat = 1) => played.push({ file, repeat }),
		});
		const mock = createMockUi();
		controller.handleAgentSettled(mock.ctx);
		assert.equal(controller.getState().hasTimer, true);

		// Break widget rendering only; elapsed passes the 3-minute mark.
		(mock.ctx.ui as any).setWidget = () => {
			throw new Error("simulated UI teardown");
		};
		controller.setLastContextTimestamp(Date.now() - 181_000);
		controller.repaint(mock.ctx);

		// Milestone fired despite the widget error, and one transient error
		// must not kill the 1s loop.
		assert.equal(played.length, 1);
		assert.ok(played[0]!.file.endsWith("sounds/3.mp3"));
		assert.equal(controller.getState().hasTimer, true);

		controller.dispose();
	});

	it("repaint stops the loop only after repeated widget failures", () => {
		const controller = new CacheTimerController();
		const mock = createMockUi();
		controller.handleAgentSettled(mock.ctx);
		assert.equal(controller.getState().hasTimer, true);

		(mock.ctx.ui as any).setWidget = () => {
			throw new Error("simulated UI teardown");
		};
		for (let i = 0; i < 4; i++) controller.repaint(mock.ctx);
		assert.equal(
			controller.getState().hasTimer,
			true,
			"loop survives transient errors",
		);
		controller.repaint(mock.ctx);
		assert.equal(
			controller.getState().hasTimer,
			false,
			"loop stops after repeated failures",
		);

		controller.dispose();
	});
});
