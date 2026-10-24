import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSpinnerLine, SpinnerController, type SpinnerFrameState } from "../spinner.ts";
import { stripAnsi, visibleWidth } from "../palette.ts";

const paint = { accent: (s: string) => s, shimmer: (s: string) => s, dim: (s: string) => s };
const base = { verb: "İşleniyor", columns: 80, timeMs: 0 };

const animations = [
	["original", 120, ["·", "✢", "✳", "✶", "✻", process.env.TERM === "xterm-ghostty" ? "*" : "✽", process.env.TERM === "xterm-ghostty" ? "*" : "✽", "✻", "✶", "✳", "✢", "·"]],
	["rotate", 240, ["|", "/", "-", "\\"]],
	["orbit", 100, ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]],
	["helix", 140, ["⢎", "⢕", "⢣", "⢱", "⡱", "⡣", "⡕", "⡎"]],
	["ripple", 120, ["⠒", "⠶", "⣶", "⣿", "⣿", "⠿", "⠶", "⠒", "⠒"]],
	["comet", 90, ["⠹", "⠛", "⠏", "⡇", "⣆", "⣤", "⣰", "⢸"]],
	["weave", 160, ["⢣", "⢎", "⡜", "⡱"]],
	["scanner", 90, ["▰▱▱▱▱", "▱▰▱▱▱", "▱▱▰▱▱", "▱▱▱▰▱", "▱▱▱▱▰", "▱▱▱▰▱", "▱▱▰▱▱", "▱▰▱▱▱"]],
	["signal", 130, ["·   ", "·)  ", "·)) ", "·)))", "·)) ", "·)  "]],
	["binary", 70, ["00000", "00001", "00011", "00010", "00110", "00111", "00101", "00100", "01100", "01101", "01111", "01110", "01010", "01011", "01001", "01000", "11000", "11001", "11011", "11010", "11110", "11111", "11101", "11100", "10100", "10101", "10111", "10110", "10010", "10011", "10001", "10000"]],
	["pivot", 110, ["┤", "┘", "┴", "└", "├", "┌", "┬", "┐"]],
	["calculus", 200, ["∂", "∇", "∫", "∑", "∏", "∞"]],
	["blink", 160, ["(•_•)", "(•_•)", "(•_•)", "(•_•)", "(-_-)", "(•_•)", "(•_•)", "(•_•)"]],
	["typing", 150, [".·˙", "·˙·", "˙·.", "·.·"]],
	["twinkle", 180, ["· ✧ ✦", "✧ ✦ ✧", "✦ ✧ ·", "✧ · ✧"]],
	["focus", 140, ["[   ]", "[ · ]", "[ • ]", "[ ● ]", "[ • ]", "[ · ]"]],
	["morse", 130, ["·-··--", "-··--·", "··--·-", "·--·-·", "--·-··", "-·-···", "·-···-", "-···-·", "···-·-", "··-·-·", "·-·-··", "-·-··-"]],
	["dna", 110, ["⢎⣉⠶⢎", "⣉⡱⠶⣉", "⣉⠶⢎⣉", "⡱⠶⣉⡱", "⠶⢎⣉⠶", "⠶⣉⡱⠶"]],
	["rain", 120, ["⠁⢀⠂ ", "⠂ ⠄ ", "⠄ ⡀⠈", "⡀⠈ ⠐", " ⠐ ⠠", " ⠠⠁⢀"]],
	["cradle", 130, ["● ●●● ", "● ●●● ", " ●●●● ", " ●●● ●", " ●●● ●", " ●●●● "]],
] as const;

function fullFrame(timeMs: number, animation: SpinnerFrameState["animation"]): string {
	return buildSpinnerLine({ ...base, columns: 0, timeMs, animation }, paint).split(" İşleniyor…")[0]!;
}

function glyph(timeMs: number, animation?: SpinnerFrameState["animation"]): string {
	return buildSpinnerLine({ ...base, columns: 1, timeMs, animation }, paint);
}

function makeContext(lines: string[]): Parameters<SpinnerController["handleAgentStart"]>[0] {
	// Only the working-message port is exercised; no live terminal is needed.
	return {
		hasUI: true,
		ui: { setWorkingMessage: (line?: string) => { if (line) lines.push(stripAnsi(line)); } },
	} as unknown as Parameters<SpinnerController["handleAgentStart"]>[0];
}

describe("spinner animations", () => {
	it("preserves every original ping-pong frame and its 120ms cadence", () => {
		const frames = ["·", "✢", "✳", "✶", "✻", process.env.TERM === "xterm-ghostty" ? "*" : "✽"];
		const cycle = [...frames, ...[...frames].reverse()];
		for (let i = 0; i < cycle.length * 2; i++) {
			assert.equal(glyph(i * 120), cycle[i % cycle.length]);
			assert.equal(glyph(i * 120 + 119), cycle[i % cycle.length]);
		}
	});

	it("rotates a single line every 240ms and loops", () => {
		for (let i = 0; i < 8; i++) {
			assert.equal(glyph(i * 240, "rotate"), ["|", "/", "-", "\\"][i % 4]);
			assert.equal(glyph(i * 240 + 239, "rotate"), ["|", "/", "-", "\\"][i % 4]);
		}
	});

	it("carries a short braille trail around an orbit every 100ms and loops", () => {
		const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		for (let i = 0; i < frames.length * 2; i++) {
			assert.equal(glyph(i * 100, "orbit"), frames[i % frames.length]);
			assert.equal(glyph(i * 100 + 99, "orbit"), frames[i % frames.length]);
		}
	});

	it("preserves the diagonal weave's frames and 160ms cadence", () => {
		const frames = ["⢣", "⢎", "⡜", "⡱"];
		for (let i = 0; i < frames.length * 2; i++) {
			assert.equal(glyph(i * 160, "weave"), frames[i % frames.length]);
			assert.equal(glyph(i * 160 + 159, "weave"), frames[i % frames.length]);
		}
	});

	it("interlaces two trails, breathes with endpoint rests, and sweeps a continuous arc", () => {
		for (const [animation, frameMs, frames] of [
			["helix", 140, ["⢎", "⢕", "⢣", "⢱", "⡱", "⡣", "⡕", "⡎"]],
			["ripple", 120, ["⠒", "⠶", "⣶", "⣿", "⣿", "⠿", "⠶", "⠒", "⠒"]],
			["comet", 90, ["⠹", "⠛", "⠏", "⡇", "⣆", "⣤", "⣰", "⢸"]],
		] as const) {
			for (let i = 0; i < frames.length * 2; i++) {
				assert.equal(glyph(i * frameMs, animation), frames[i % frames.length]);
				assert.equal(glyph(i * frameMs + frameMs - 1, animation), frames[i % frames.length]);
			}
		}
	});

	it("keeps the helix weight steady and the comet arc connected across the loop seam", () => {
		const perimeter = [1, 2, 4, 64, 128, 32, 16, 8];
		for (let i = 0; i < 16; i++) {
			const helixMask = glyph(i * 140, "helix").charCodeAt(0) - 0x2800;
			assert.equal(helixMask.toString(2).replaceAll("0", "").length, 4);
			let expectedArc = 0;
			for (let tail = 0; tail < 4; tail++) expectedArc |= perimeter[(i - tail + 8) % 8]!;
			assert.equal(glyph(i * 90, "comet").charCodeAt(0) - 0x2800, expectedArc);
		}
		const densities = [2, 4, 6, 8, 8, 6, 4, 2, 2];
		for (const [i, density] of densities.entries()) {
			const mask = glyph(i * 120, "ripple").charCodeAt(0) - 0x2800;
			assert.equal(mask.toString(2).replaceAll("0", "").length, density);
		}
	});

	it("preserves all frames and cadences across two complete cycles", () => {
		for (const [animation, frameMs, frames] of animations) {
			for (let i = 0; i < frames.length * 2; i++) {
				assert.equal(fullFrame(i * frameMs, animation), frames[i % frames.length], animation);
				assert.equal(fullFrame(i * frameMs + frameMs - 1, animation), frames[i % frames.length], animation);
			}
		}
	});

	it("changes exactly one Gray-code bit per tick, including the loop seam", () => {
		const frames = Array.from({ length: 32 }, (_, i) => fullFrame(i * 70, "binary"));
		assert.equal(new Set(frames).size, 32);
		for (let i = 0; i < frames.length; i++) {
			const current = frames[i]!;
			const next = fullFrame((i + 1) * 70, "binary");
			assert.match(current, /^[01]{5}$/);
			assert.equal([...current].filter((bit, index) => bit !== next[index]).length, 1);
		}
		assert.equal(fullFrame(32 * 70, "binary"), frames[0]);
	});

	it("keeps frame widths constant and respects narrow viewports", () => {
		for (const [animation, frameMs, frames] of animations) {
			const width = visibleWidth(frames[0]);
			for (let i = 0; i < frames.length * 2; i++) {
				assert.equal(visibleWidth(fullFrame(i * frameMs, animation)), width, animation);
			}

			for (let timeMs = 0; timeMs < 3000; timeMs += 20) {
				assert.equal(visibleWidth(glyph(timeMs, animation)), 1);
				for (const columns of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 80]) {
					const line = buildSpinnerLine({ ...base, timeMs, animation, columns }, paint);
					assert.ok(visibleWidth(line) <= columns);
					assert.ok(!line.includes("\n"));
				}
			}
		}
	});

	it("falls back to one cell only below the multi-cell layout threshold", () => {
		for (const [animation, frameMs, frames] of animations) {
			const width = visibleWidth(frames[0]);
			if (width === 1) continue;
			for (let i = 0; i < frames.length; i++) {
				for (let columns = 1; columns < width + 4; columns++) {
					const line = buildSpinnerLine({ ...base, animation, timeMs: i * frameMs, columns }, paint);
					assert.ok(line.startsWith("·"), `${animation}: ${columns}`);
					assert.ok(visibleWidth(line) <= columns);
				}
				const line = buildSpinnerLine({ ...base, animation, timeMs: i * frameMs, columns: width + 4 }, paint);
				assert.equal(line, `${frames[i]} İş…`);
				assert.equal(visibleWidth(line), width + 4);
			}
		}
	});

	it("can randomly select all twenty animations on the first run", (t) => {
		let random = 0;
		t.mock.method(Math, "random", () => random);
		for (const [i, [, , frames]] of animations.entries()) {
			const first = frames[0];
			random = (i + 0.5) / animations.length;
			const controller = new SpinnerController();
			const lines: string[] = [];
			try {
				controller.handleAgentStart(makeContext(lines));
				assert.ok(lines.at(-1)?.startsWith(`${first} `));
			} finally {
				controller.dispose();
			}
		}
	});

	it("never repeats the previous animation when a new run starts", (t) => {
		t.mock.method(Math, "random", () => 0);
		const controller = new SpinnerController();
		const lines: string[] = [];
		try {
			for (let i = 0; i < 4; i++) controller.handleAgentStart(makeContext(lines));
			assert.deepEqual(lines.map((line) => line.split(" ")[0]), ["·", "|", "·", "|"]);
		} finally {
			controller.dispose();
		}
	});

	it("repaints at each animation's own cadence without leaking old intervals", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"] });
		let random = 0;
		t.mock.method(Math, "random", () => random);
		for (const [i, [, frameMs, frames]] of animations.entries()) {
			const [first, second] = frames;
			random = (i + 0.5) / animations.length;
			const controller = new SpinnerController();
			const lines: string[] = [];
			try {
				controller.handleAgentStart(makeContext(lines));
				assert.ok(lines.at(-1)?.startsWith(`${first} `));
				const count = lines.length;
				t.mock.timers.tick(frameMs - 1);
				assert.equal(lines.length, count);
				t.mock.timers.tick(1);
				assert.equal(lines.length, count + 1);
				assert.ok(lines.at(-1)?.startsWith(`${second} `));
			} finally {
				controller.dispose();
			}
			const count = lines.length;
			t.mock.timers.tick(1000);
			assert.equal(lines.length, count);
		}
	});

	it("changes randomly at a completed cycle after 8 seconds without resetting elapsed time", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"] });
		t.mock.method(Math, "random", () => 0);
		const controller = new SpinnerController();
		const lines: string[] = [];
		try {
			controller.handleAgentStart(makeContext(lines));
			// Original: 12 * 120ms per cycle, so six complete cycles = 8640ms.
			for (let i = 0; i < 71; i++) t.mock.timers.tick(120);
			assert.equal(lines.length, 72);
			assert.ok(lines.at(-1)?.startsWith("· "));
			t.mock.timers.tick(120);
			assert.ok(lines.at(-1)?.startsWith("| "));
			assert.ok(lines.at(-1)?.includes("8sn"));
			const count = lines.length;
			t.mock.timers.tick(239);
			assert.equal(lines.length, count);
			t.mock.timers.tick(1);
			assert.ok(lines.at(-1)?.startsWith("/ "));
			// Rotate also runs for nine complete cycles, then picks original again.
			for (let i = 0; i < 35; i++) t.mock.timers.tick(240);
			assert.ok(lines.at(-1)?.startsWith("· "));
			assert.ok(lines.at(-1)?.includes("17sn"));
			assert.equal(controller.getState().animStartMs, 0);
		} finally {
			controller.dispose();
		}
		const count = lines.length;
		t.mock.timers.tick(20_000);
		assert.equal(lines.length, count);
	});

	it("finishes whole cycles for every animation and preserves thinking and rate state", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"] });
		let random = 0;
		t.mock.method(Math, "random", () => random);
		for (const [i, [, frameMs, frames]] of animations.entries()) {
			const frameCount = frames.length;
			const nextFirst = animations[i === animations.length - 1 ? i - 1 : animations.length - 1][2][0];
			random = (i + 0.5) / animations.length;
			const controller = new SpinnerController();
			const lines: string[] = [];
			try {
				controller.handleAgentStart(makeContext(lines));
				controller.beginThinking();
				controller.setTokensPerSecond(42);
				const state = controller.getState();
				// Choosing the last candidate also checks exclusion at the upper random bound.
				random = 0.999999;
				const cycleMs = frameMs * frameCount;
				const steps = Math.ceil(8000 / cycleMs) * frameCount;
				for (let step = 1; step < steps; step++) t.mock.timers.tick(frameMs);
				assert.equal(lines.length, steps);
				assert.ok(!lines.at(-1)?.startsWith(`${nextFirst} `));
				t.mock.timers.tick(frameMs);
				assert.equal(lines.length, steps + 1);
				assert.ok(lines.at(-1)?.startsWith(`${nextFirst} `));
				assert.deepEqual(controller.getState(), state);
			} finally {
				controller.dispose();
			}
		}
	});

	it("keeps the glyph clock separate from elapsed time, including invalid local clocks", () => {
		const line = buildSpinnerLine({ ...base, animation: "orbit", timeMs: 65_500, animationTimeMs: 0 }, paint);
		assert.ok(line.startsWith("⠋ "));
		assert.ok(line.includes("1dk 5sn"));
		for (const animationTimeMs of [NaN, Infinity, -1]) {
			assert.equal(
				buildSpinnerLine({ ...base, columns: 1, animation: "orbit", timeMs: 100, animationTimeMs }, paint),
				"⠙",
			);
		}
	});
});
