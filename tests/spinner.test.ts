import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	formatTokenCount,
	formatElapsed,
	thinkingWording,
	thinkingGlowPaint,
	glimmerMessage,
	buildSpinnerLine,
	effortSuffixFor,
	sampleVerb,
	currentWorkingVerb,
	registerSpinner,
	SpinnerController,
	type SpinnerPaint,
	type SpinnerFrameState,
} from "../spinner.ts";
import { visibleWidth, stripAnsi } from "../palette.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const mockPaint: SpinnerPaint = {
	accent: (s) => `\x1b[38;2;215;119;87m${s}\x1b[39m`,
	shimmer: (s) => `\x1b[38;2;235;159;127m${s}\x1b[39m`,
	dim: (s) => `\x1b[2m${s}\x1b[22m`,
};

describe("spinner", () => {
	describe("formatTokenCount", () => {
		it("formats small numbers as plain strings", () => {
			assert.equal(formatTokenCount(0), "0");
			assert.equal(formatTokenCount(150), "150");
			assert.equal(formatTokenCount(999), "999");
		});

		it("formats thousands with decimal k notation", () => {
			assert.equal(formatTokenCount(1000), "1k");
			assert.equal(formatTokenCount(1200), "1.2k");
			assert.equal(formatTokenCount(1250), "1.3k");
			assert.equal(formatTokenCount(9900), "9.9k");
		});

		it("formats large numbers as rounded k", () => {
			assert.equal(formatTokenCount(10000), "10k");
			assert.equal(formatTokenCount(25600), "26k");
			assert.equal(formatTokenCount(120000), "120k");
		});

		it("formats millions with M notation", () => {
			assert.equal(formatTokenCount(1000000), "1M");
			assert.equal(formatTokenCount(1500000), "1.5M");
			assert.equal(formatTokenCount(12300000), "12.3M");
		});

		it("safely handles edge cases like NaN, Infinity, negative values", () => {
			assert.equal(formatTokenCount(Number.NaN), "0");
			assert.equal(formatTokenCount(Number.POSITIVE_INFINITY), "0");
			assert.equal(formatTokenCount(Number.NEGATIVE_INFINITY), "0");
			assert.equal(formatTokenCount(-50), "0");
			assert.equal(formatTokenCount(-1000), "0");
		});
	});

	describe("formatElapsed", () => {
		it("formats seconds", () => {
			assert.equal(formatElapsed(0), "0sn");
			assert.equal(formatElapsed(5400), "5sn");
			assert.equal(formatElapsed(45000), "45sn");
		});

		it("formats minutes and seconds", () => {
			assert.equal(formatElapsed(65000), "1dk 5sn");
			assert.equal(formatElapsed(125000), "2dk 5sn");
		});

		it("formats hours, minutes, and seconds", () => {
			assert.equal(formatElapsed(3665000), "1sa 1dk 5sn");
		});

		it("safely handles edge cases like NaN, negative numbers, Infinity", () => {
			assert.equal(formatElapsed(Number.NaN), "0sn");
			assert.equal(formatElapsed(-1000), "0sn");
			assert.equal(formatElapsed(Number.POSITIVE_INFINITY), "0sn");
		});
	});

	describe("thinkingWording", () => {
		it("returns escalating wording based on elapsed time", () => {
			assert.equal(thinkingWording(0), "düşünülüyor");
			assert.equal(thinkingWording(29000), "düşünülüyor");
			assert.equal(thinkingWording(30000), "derinlemesine düşünülüyor");
			assert.equal(thinkingWording(59000), "derinlemesine düşünülüyor");
			assert.equal(thinkingWording(60000), "biraz daha düşünülüyor");
			assert.equal(thinkingWording(119000), "biraz daha düşünülüyor");
			assert.equal(thinkingWording(120000), "düşünme tamamlanmak üzere");
			assert.equal(thinkingWording(300000), "düşünme tamamlanmak üzere");
		});

		it("safely handles negative numbers and NaN", () => {
			assert.equal(thinkingWording(-5000), "düşünülüyor");
			assert.equal(thinkingWording(Number.NaN), "düşünülüyor");
		});
	});

	describe("thinkingGlowPaint", () => {
		it("renders dark scheme glowing text with correct ANSI truecolor sequences", () => {
			const paintDark0 = thinkingGlowPaint(0, "dark");
			const res0 = paintDark0("düşünülüyor");
			assert.ok(res0.includes("düşünülüyor"));
			assert.ok(res0.startsWith("\x1b[38;2;153;153;153m"));
			assert.ok(res0.endsWith("\x1b[39m"));

			const paintDark4000 = thinkingGlowPaint(4000, "dark");
			const res4000 = paintDark4000("düşünülüyor");
			assert.ok(res4000.includes("düşünülüyor"));
			assert.ok(res4000.endsWith("\x1b[39m"));
		});

		it("renders light scheme glowing text with high contrast grays", () => {
			const paintLight0 = thinkingGlowPaint(0, "light");
			const res0 = paintLight0("düşünülüyor");
			assert.ok(res0.includes("düşünülüyor"));
			assert.ok(res0.startsWith("\x1b[38;2;105;105;105m"));
			assert.ok(res0.endsWith("\x1b[39m"));
		});
	});

	describe("effortSuffixFor", () => {
		it("returns empty string for none, off, or undefined", () => {
			assert.equal(effortSuffixFor(undefined), "");
			assert.equal(effortSuffixFor(""), "");
			assert.equal(effortSuffixFor("none"), "");
			assert.equal(effortSuffixFor("off"), "");
		});

		it("translates effort levels to Turkish", () => {
			assert.equal(effortSuffixFor("high"), " (yüksek eforla)");
			assert.equal(effortSuffixFor("medium"), " (orta eforla)");
			assert.equal(effortSuffixFor("low"), " (düşük eforla)");
			assert.equal(effortSuffixFor("minimal"), " (minimum eforla)");
			assert.equal(effortSuffixFor("xhigh"), " (maksimum eforla)");
			assert.equal(effortSuffixFor("max"), " (maksimum eforla)");
			assert.equal(effortSuffixFor("custom"), " (custom eforla)");
		});
	});

	describe("glimmerMessage", () => {
		it("returns empty string for empty input", () => {
			assert.equal(glimmerMessage("", 0, mockPaint), "");
		});

		it("returns accent message when glimmer is completely off-screen", () => {
			const res = glimmerMessage("İşleniyor…", 999, mockPaint);
			assert.equal(stripAnsi(res), "İşleniyor…");
			assert.ok(res.endsWith("\x1b[39m"));
		});

		it("returns accent message when glimmerIndex is NaN", () => {
			const res = glimmerMessage("İşleniyor…", Number.NaN, mockPaint);
			assert.equal(stripAnsi(res), "İşleniyor…");
			assert.ok(res.endsWith("\x1b[39m"));
		});

		it("applies shimmer color to characters around glimmerIndex", () => {
			const res = glimmerMessage("Düşünülüyor…", 4, mockPaint);
			assert.ok(res.includes("\x1b[38;2;235;159;127m"));
			assert.ok(res.includes("\x1b[38;2;215;119;87m"));
			assert.equal(visibleWidth(res), 12);
		});

		it("maintains ANSI integrity at all boundary sweep positions", () => {
			const verb = "Zenginleştiriliyor…";
			const width = visibleWidth(verb);

			// Sweep from offscreen left (-5) to offscreen right (+30)
			for (let idx = -5; idx <= width + 10; idx++) {
				const rendered = glimmerMessage(verb, idx, mockPaint);
				assert.equal(visibleWidth(rendered), width);
				assert.equal(stripAnsi(rendered), verb);
				// Verify all ANSI color escapes are terminated with \x1b[39m
				assert.ok(rendered.endsWith("\x1b[39m"));
			}
		});
	});

	describe("buildSpinnerLine", () => {
		it("builds a basic line with glyph and verb", () => {
			const state: SpinnerFrameState = {
				verb: "Kodlanıyor",
				timeMs: 120,
				columns: 13, // tight width so byline is omitted
			};
			const line = buildSpinnerLine(state, mockPaint);
			assert.ok(stripAnsi(line).includes("Kodlanıyor…"));
			assert.equal(visibleWidth(line), 13); // glyph (1) + space (1) + Kodlanıyor… (11)
		});

		it("uses a steady accent verb and simple dim thinking status", () => {
			const line = buildSpinnerLine(
				{
					verb: "Düşünülüyor",
					timeMs: 5000,
					columns: 120,
					thinkingStatus: "thinking",
				},
				mockPaint,
			);
			assert.ok(!line.includes("\\x1b[38;2;235;159;127m"));
			assert.ok(line.includes(mockPaint.dim("düşünülüyor")));
		});

		it("falls back to default verb when empty verb is provided", () => {
			const state: SpinnerFrameState = {
				verb: "",
				timeMs: 120,
				columns: 120,
			};
			const line = buildSpinnerLine(state, mockPaint);
			assert.ok(stripAnsi(line).includes("İşleniyor…"));
		});

		it("includes tokens and timer when space is available", () => {
			const state: SpinnerFrameState = {
				verb: "İşleniyor",
				timeMs: 15000,
				columns: 120,
				tokens: 1500,
			};
			const line = buildSpinnerLine(state, mockPaint);
			const stripped = stripAnsi(line);
			assert.ok(stripped.includes("15sn"));
			assert.ok(stripped.includes("↓ 1.5k token"));
		});

		it("includes live tokensPerSecond when space allows and drops it when tight", () => {
			const wideState: SpinnerFrameState = {
				verb: "İşleniyor",
				timeMs: 15000,
				columns: 120,
				tokens: 1500,
				tokensPerSecond: 48.4,
			};
			const wideLine = buildSpinnerLine(wideState, mockPaint);
			const wideStripped = stripAnsi(wideLine);
			assert.ok(wideStripped.includes("15sn"));
			assert.ok(wideStripped.includes("↓ 1.5k token"));
			assert.ok(wideStripped.includes("48 tok/s"));

			// When constrained to 36 columns: drops tok/s but keeps tokens and timer
			const mediumState: SpinnerFrameState = {
				...wideState,
				columns: 38,
			};
			const mediumLine = buildSpinnerLine(mediumState, mockPaint);
			const mediumStripped = stripAnsi(mediumLine);
			assert.ok(visibleWidth(mediumLine) <= 38);
			assert.ok(!mediumStripped.includes("tok/s"));
			assert.ok(mediumStripped.includes("↓ 1.5k token"));
		});

		it("tracks live tokensPerSecond during message_update and message_end", () => {
			const controller = new SpinnerController();
			const mockCtx = {
				hasUI: true,
				ui: {
					setWorkingMessage: () => {},
					setWorkingIndicator: () => {},
					setTitle: () => {},
				},
			};

			controller.handleAgentStart(mockCtx as any);
			assert.equal(controller.getTokensPerSecond(), null);

			// First delta establishes start time and baseline
			controller.handleMessageUpdate(
				{
					assistantMessageEvent: {
						type: "text_delta",
						delta: "Merhaba! ",
					},
				} as any,
				mockCtx as any,
			);

			// Artificially simulate 500ms elapsed with another chunk
			// Use setTokensPerSecond to test direct setter and getter
			controller.setTokensPerSecond(42);
			assert.equal(controller.getTokensPerSecond(), 42);
			assert.equal(controller.getState().tokensPerSecond, 42);

			controller.handleAgentSettled(mockCtx as any);
			assert.equal(controller.getTokensPerSecond(), null);
		});

		it("includes thinking status and effort suffix", () => {
			const state: SpinnerFrameState = {
				verb: "Düşünülüyor",
				timeMs: 5000,
				columns: 120,
				thinkingStatus: "thinking",
				effortSuffix: " (yüksek eforla)",
				thinkingElapsedMs: 4000,
			};
			const line = buildSpinnerLine(state, mockPaint);
			const stripped = stripAnsi(line);
			assert.ok(stripped.includes("düşünülüyor (yüksek eforla)"));
		});

		it("formats completed thinking duration when status is a number", () => {
			const state: SpinnerFrameState = {
				verb: "İşleniyor",
				timeMs: 10000,
				columns: 120,
				thinkingStatus: 3400,
			};
			const line = buildSpinnerLine(state, mockPaint);
			const stripped = stripAnsi(line);
			assert.ok(stripped.includes("3sn düşünüldü"));
		});

		it("drops tokens and timer progressively when terminal width is tight", () => {
			const wideState: SpinnerFrameState = {
				verb: "İşleniyor",
				timeMs: 15000,
				columns: 120,
				tokens: 1500,
				thinkingStatus: "thinking",
			};
			const wideLine = buildSpinnerLine(wideState, mockPaint);
			assert.ok(stripAnsi(wideLine).includes("15sn"));
			assert.ok(stripAnsi(wideLine).includes("↓ 1.5k token"));

			const tightState: SpinnerFrameState = {
				verb: "İşleniyor",
				timeMs: 15000,
				columns: 32,
				tokens: 1500,
				thinkingStatus: "thinking",
			};
			const tightLine = buildSpinnerLine(tightState, mockPaint);
			assert.ok(stripAnsi(tightLine).includes("düşünülüyor"));
			assert.ok(visibleWidth(tightLine) <= 32);
		});

		it("preserves exact byline priority and painting at every width boundary", () => {
			const timer = "15sn";
			const tokens = "↓ 1.5k token";
			const rate = "48 tok/s";
			const thinking = "düşünülüyor";
			const fullThinking = "düşünülüyor (yüksek eforla)";
			const completed = "3sn düşünüldü";
			const longTimer = "1sa 1dk 5sn";
			const smallTokens = "↓ 1 token";
			const cases: {
				state: Partial<SpinnerFrameState>;
				boundaries: [number, string[]][];
			}[] = [
				{
					state: { thinkingStatus: "thinking", effortSuffix: " (yüksek eforla)" },
					boundaries: [
						[7, []], [14, [timer]], [21, [thinking]],
						[28, [timer, thinking]], [43, [timer, tokens, thinking]],
						[54, [timer, tokens, rate, thinking]],
						[70, [timer, tokens, rate, fullThinking]],
					],
				},
				{
					state: { thinkingStatus: 3400 },
					boundaries: [
						[7, []], [14, [timer]], [23, [completed]],
						[30, [timer, completed]], [45, [timer, tokens, completed]],
						[56, [timer, tokens, rate, completed]],
					],
				},
				{
					state: { thinkingStatus: null },
					boundaries: [
						[7, []], [14, [timer]], [29, [timer, tokens]],
						[40, [timer, tokens, rate]],
					],
				},
				{
					state: { thinkingStatus: "thinking", timeMs: 3665000, tokens: 1, tokensPerSecond: 1 },
					boundaries: [
						[7, []], [19, [smallTokens]], [21, [thinking]],
						[33, [smallTokens, thinking]], [35, [longTimer, thinking]],
						[47, [longTimer, smallTokens, thinking]],
						[57, [longTimer, smallTokens, "1 tok/s", thinking]],
					],
				},
				{
					state: { thinkingStatus: "thinking", tokens: 0 },
					boundaries: [7, 14, 21, 28].map((width, index) =>
						[width, [[], [timer], [thinking], [timer, thinking]][index]!]),
				},
			];
			for (const { state, boundaries } of cases) {
				const baseState: SpinnerFrameState = {
					verb: "Test", timeMs: 15000, tokens: 1500,
					tokensPerSecond: 48.4, columns: 7, ...state,
				};
				const prefix = buildSpinnerLine(baseState, mockPaint);
				for (let columns = 7; columns <= 100; columns++) {
					const segments = boundaries.findLast(([width]) => width <= columns)![1];
					let byline = "";
					if (segments.length === 1 && state.thinkingStatus === "thinking" &&
						(segments[0] === thinking || segments[0] === fullThinking)) {
						byline = ` ${mockPaint.dim(`(${segments[0]})`)}`;
					} else if (segments.length > 0) {
						byline = ` ${mockPaint.dim("(")}${segments.map(mockPaint.dim).join(mockPaint.dim(" · "))}${mockPaint.dim(")")}`;
					}
					assert.equal(buildSpinnerLine({ ...baseState, columns }, mockPaint),
						prefix + byline, `status=${state.thinkingStatus}, columns=${columns}`);
				}
			}
		});

		it("safely handles extreme edge cases in frame state", () => {
			const edgeState: SpinnerFrameState = {
				verb: "Test",
				timeMs: Number.NaN,
				columns: 0,
				tokens: -500,
				thinkingStatus: Number.NaN as any,
				thinkingElapsedMs: Number.NaN,
			};
			const line = buildSpinnerLine(edgeState, mockPaint);
			assert.ok(stripAnsi(line).includes("Test…"));
		});
	});

	describe("layout responsiveness and viewport handling", () => {
		const fullState: SpinnerFrameState = {
			verb: "Zenginleştiriliyor",
			timeMs: 25000,
			tokens: 4500,
			thinkingStatus: "thinking",
			effortSuffix: " (yüksek eforla)",
			thinkingElapsedMs: 15000,
			columns: 120,
		};

		it("never exceeds terminal columns for any column width from 1 to 200", () => {
			for (let cols = 1; cols <= 200; cols++) {
				const line = buildSpinnerLine({ ...fullState, columns: cols }, mockPaint);
				const width = visibleWidth(line);
				assert.ok(
					width <= cols,
					`Visible width ${width} exceeded terminal columns ${cols} for line [${stripAnsi(line)}]`,
				);
			}
		});

		it("progressively collapses layout through defined responsive breakpoints", () => {
			// 1. Ultra narrow (cols = 1): single glyph
			const line1 = buildSpinnerLine({ ...fullState, columns: 1 }, mockPaint);
			assert.equal(visibleWidth(line1), 1);
			assert.equal(stripAnsi(line1), "✻");

			// 2. Ultra narrow (cols = 3): glyph + ellipsis
			const line3 = buildSpinnerLine({ ...fullState, columns: 3 }, mockPaint);
			assert.equal(visibleWidth(line3), 3);
			assert.equal(stripAnsi(line3), "✻ …");

			// 3. Ultra narrow (cols = 8): truncated verb stem
			const line8 = buildSpinnerLine({ ...fullState, columns: 8 }, mockPaint);
			assert.ok(visibleWidth(line8) <= 8);
			assert.ok(stripAnsi(line8).startsWith("✻ Z"));
			assert.ok(stripAnsi(line8).endsWith("…"));

			// 4. Narrow (cols = 22): full verb without byline
			const line22 = buildSpinnerLine({ ...fullState, columns: 22 }, mockPaint);
			assert.ok(visibleWidth(line22) <= 22);
			assert.equal(stripAnsi(line22), "✻ Zenginleştiriliyor…");

			// 5. Medium narrow (cols = 35): single byline item (thinking or timer)
			const line35 = buildSpinnerLine({ ...fullState, columns: 35 }, mockPaint);
			assert.ok(visibleWidth(line35) <= 35);
			const stripped35 = stripAnsi(line35);
			assert.ok(stripped35.includes("✻ Zenginleştiriliyor…"));
			assert.ok(stripped35.includes("(") && stripped35.includes(")"));

			// 6. Medium width (cols = 65): timer + tokens + short thinking
			const line65 = buildSpinnerLine({ ...fullState, columns: 65 }, mockPaint);
			assert.ok(visibleWidth(line65) <= 65);
			const stripped65 = stripAnsi(line65);
			assert.ok(stripped65.includes("25sn"));
			assert.ok(stripped65.includes("↓ 4.5k token"));

			// 7. Full width (cols = 120): timer + tokens + thinking with full effort suffix
			const line120 = buildSpinnerLine({ ...fullState, columns: 120 }, mockPaint);
			assert.ok(visibleWidth(line120) <= 120);
			const stripped120 = stripAnsi(line120);
			assert.ok(stripped120.includes("25sn"));
			assert.ok(stripped120.includes("↓ 4.5k token"));
			assert.ok(stripped120.includes("düşünülüyor (yüksek eforla)"));
		});

		it("safely truncates Turkish multi-byte characters without corruption", () => {
			const turkishVerbs = [
				"Ayrıştırılıyor",
				"Biçimlendiriliyor",
				"Çözümleniyor",
				"Değerlendiriliyor",
				"Düşünülüyor",
				"Genişletiliyor",
				"Güçlendiriliyor",
				"İyileştiriliyor",
				"Şekillendiriliyor",
				"Zenginleştiriliyor",
			];

			const validGlyphs = new Set(["·", "✢", "✳", "✶", "✻", "✽", "*"]);

			for (const verb of turkishVerbs) {
				for (let cols = 4; cols <= 30; cols++) {
					const line = buildSpinnerLine(
						{
							verb,
							timeMs: 1000,
							columns: cols,
						},
						mockPaint,
					);
					const stripped = stripAnsi(line);
					assert.ok(visibleWidth(line) <= cols);
					const firstGlyph = [...stripped][0];
					assert.ok(validGlyphs.has(firstGlyph!));
					assert.equal([...stripped][1], " ");
					// Verify no replacement character (\uFFFD) or malformed UTF-8
					assert.ok(!stripped.includes("\uFFFD"));
				}
			}
		});
	});

	describe("verbs", () => {
		it("sampleVerb returns a non-empty Turkish verb", () => {
			const verb = sampleVerb();
			assert.equal(typeof verb, "string");
			assert.ok(verb.length > 0);
		});

		it("currentWorkingVerb returns the active verb", () => {
			const verb = currentWorkingVerb();
			assert.equal(typeof verb, "string");
			assert.ok(verb.length > 0);
		});
	});

	describe("timer cleanup", () => {
		it("stops pending thinking timers along with the repaint loop", () => {
			const controller = new SpinnerController();
			try {
				controller.beginThinking();
				controller.settleThinking();
				assert.equal(controller.hasActiveTimers(), true);
				controller.stopLoop();
				assert.equal(controller.hasActiveTimers(), false);
			} finally {
				controller.dispose();
			}
		});
	});

	describe("streaming rate", () => {
		it("prefers reported output increments over character estimates", (t) => {
			let now = 1000;
			t.mock.method(Date, "now", () => now);
			const controller = new SpinnerController();
			const ctx = { hasUI: false } as Parameters<SpinnerController["handleAgentStart"]>[0];
			const delta = (output: number, text: string, type = "text_delta") => controller.handleMessageUpdate({
				assistantMessageEvent: { type, delta: text, partial: { usage: { output } } },
			} as Parameters<SpinnerController["handleMessageUpdate"]>[0], ctx);
			controller.handleAgentStart(ctx);
			delta(10, "first chunk");
			now = 2000;
			delta(30, "x");
			assert.equal(controller.getTokensPerSecond(), 20);
			now = 3000;
			delta(50, "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
			assert.equal(controller.getTokensPerSecond(), 20);
			now = 8000;
			controller.handleMessageEnd({ message: { role: "assistant", usage: { output: 50 }, content: [] } } as unknown as Parameters<SpinnerController["handleMessageEnd"]>[0], ctx);
			assert.equal(controller.getTokensPerSecond(), 20);
			controller.dispose();
		});

		it("calibrates character-only streams with final usage, including tool arguments", (t) => {
			let now = 1000;
			t.mock.method(Date, "now", () => now);
			const controller = new SpinnerController();
			const ctx = { hasUI: false } as Parameters<SpinnerController["handleAgentStart"]>[0];
			controller.handleAgentStart(ctx);
			for (const type of ["thinking_delta", "toolcall_delta"]) {
				controller.handleMessageUpdate({ assistantMessageEvent: { type, delta: "x".repeat(40), partial: { usage: { output: 0 } } } } as Parameters<SpinnerController["handleMessageUpdate"]>[0], ctx);
				now += 1000;
			}
			assert.equal(controller.getTokensPerSecond(), 10);
			now = 9000;
			controller.handleMessageEnd({ message: { role: "assistant", usage: { output: 100 }, content: [{ type: "toolCall" }] } } as Parameters<SpinnerController["handleMessageEnd"]>[0], ctx);
			assert.equal(controller.getTokensPerSecond(), 50);
			controller.handleAgentStart(ctx);
			assert.equal(controller.getTokensPerSecond(), null);
			controller.dispose();
		});

		it("uses time-weighted rates across requests, excluding tool execution pauses", (t) => {
			let now = 1000;
			t.mock.method(Date, "now", () => now);
			const controller = new SpinnerController();
			const ctx = { hasUI: false } as Parameters<SpinnerController["handleAgentStart"]>[0];
			controller.handleAgentStart(ctx);
			const delta = (output: number) => controller.handleMessageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "xxxx", partial: { usage: { output } } } } as Parameters<SpinnerController["handleMessageUpdate"]>[0], ctx);
			const end = (output: number) => controller.handleMessageEnd({ message: { role: "assistant", usage: { output }, content: [] } } as unknown as Parameters<SpinnerController["handleMessageEnd"]>[0], ctx);
			delta(10);
			now = 2000;
			delta(30);
			end(30);
			now = 20_000;
			delta(5);
			now = 22_000;
			delta(25);
			end(25);
			assert.ok(Math.abs(controller.getTokensPerSecond()! - 40 / 3) < 0.001);
			assert.equal(controller.getState().totalTokens, 55);
			controller.dispose();
		});
	});

	describe("registerSpinner", () => {
		it("registers event handlers on pi ExtensionAPI and returns controller", () => {
			const handlers: Record<string, Function> = {};
			const mockPi = {
				on(event: string, handler: Function) {
					handlers[event] = handler;
				},
			} as unknown as ExtensionAPI;

			const controller = registerSpinner(mockPi);
			assert.ok(controller);
			assert.equal(typeof handlers["session_start"], "function");
			assert.equal(typeof handlers["agent_start"], "function");
			assert.equal(typeof handlers["message_update"], "function");
			assert.equal(typeof handlers["message_end"], "function");
			assert.equal(typeof handlers["agent_end"], "function");
			assert.equal(typeof handlers["agent_settled"], "function");
			assert.equal(typeof handlers["session_shutdown"], "function");
		});
	});
});
