import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	rgb,
	hexToRgb,
	rgbTo256,
	fgAnsi,
	fg,
	bgAnsi,
	bg,
	isValidHex,
	stripAnsi,
	visibleWidth,
	resolvePalette,
	CLAUDE_CODE_DARK_PALETTE,
	CLAUDE_CODE_LIGHT_PALETTE,
	RESET,
	FG_DEFAULT,
	BG_DEFAULT,
} from "../palette.ts";

describe("palette", () => {
	it("rgb creates Rgb object", () => {
		const color = rgb(215, 119, 87);
		assert.deepEqual(color, { r: 215, g: 119, b: 87 });
	});

	it("hexToRgb parses 6-digit hex with and without hash", () => {
		assert.deepEqual(hexToRgb("#D77757"), { r: 215, g: 119, b: 87 });
		assert.deepEqual(hexToRgb("D77757"), { r: 215, g: 119, b: 87 });
		assert.deepEqual(hexToRgb("#000000"), { r: 0, g: 0, b: 0 });
		assert.deepEqual(hexToRgb("#FFFFFF"), { r: 255, g: 255, b: 255 });
	});

	it("hexToRgb parses 3-digit hex shorthand", () => {
		assert.deepEqual(hexToRgb("#fff"), { r: 255, g: 255, b: 255 });
		assert.deepEqual(hexToRgb("000"), { r: 0, g: 0, b: 0 });
		assert.deepEqual(hexToRgb("#f00"), { r: 255, g: 0, b: 0 });
	});

	it("hexToRgb handles invalid values safely", () => {
		assert.deepEqual(hexToRgb("invalid"), { r: 0, g: 0, b: 0 });
		assert.deepEqual(hexToRgb(""), { r: 0, g: 0, b: 0 });
		assert.deepEqual(hexToRgb(null as any), { r: 0, g: 0, b: 0 });
		assert.deepEqual(hexToRgb(undefined as any), { r: 0, g: 0, b: 0 });
	});

	it("rgbTo256 converts RGB values accurately to 256-color palette indices", () => {
		// Grayscale bounds
		assert.equal(rgbTo256(0, 0, 0), 16);
		assert.equal(rgbTo256(255, 255, 255), 231);
		assert.equal(rgbTo256(128, 128, 128), 244);

		// Brand colors
		const claude256 = rgbTo256(215, 119, 87);
		assert.equal(typeof claude256, "number");
		assert.ok(claude256 >= 16 && claude256 <= 231);

		// Edge cases: NaN, negative, out-of-bounds
		assert.equal(rgbTo256(Number.NaN, 0, 0), 16);
		assert.equal(rgbTo256(-10, -20, -30), 16);
		assert.equal(rgbTo256(300, 300, 300), 231);
	});

	it("fgAnsi generates 24-bit truecolor ANSI escape sequences for hex", () => {
		const ansi = fgAnsi("#D77757");
		assert.equal(ansi, "\x1b[38;2;215;119;87m");
	});

	it("fgAnsi generates 256-color ANSI escape sequences in 256color mode", () => {
		const ansi256 = fgAnsi("#D77757", "256color");
		assert.ok(ansi256.startsWith("\x1b[38;5;"));
		assert.ok(ansi256.endsWith("m"));
	});

	it("fgAnsi generates 256-color ANSI escape sequences for numbers", () => {
		assert.equal(fgAnsi(1), "\x1b[31m");
		assert.equal(fgAnsi(9), "\x1b[91m");
		assert.equal(fgAnsi(200), "\x1b[38;5;200m");
	});

	it("fgAnsi safely handles invalid inputs and numbers", () => {
		assert.equal(fgAnsi(null as any), FG_DEFAULT);
		assert.equal(fgAnsi(undefined as any), FG_DEFAULT);
		assert.equal(fgAnsi(-1 as any), FG_DEFAULT);
		assert.equal(fgAnsi(Number.NaN as any), FG_DEFAULT);
	});

	it("keeps foreground and background numeric encodings distinct", () => {
		for (let value = 0; value <= 255; value++) {
			const foreground = value < 8 ? `\x1b[${30 + value}m`
				: value < 16 ? `\x1b[${82 + value}m` : `\x1b[38;5;${value}m`;
			assert.equal(fgAnsi(value + 0.25), value === 255 ? FG_DEFAULT : foreground);
			assert.equal(fgAnsi(value), foreground);
			assert.equal(bgAnsi(value), `\x1b[48;5;${value}m`);
		}
		for (const value of [NaN, Infinity, -1, 256, null, undefined, "#12xz89", "##fff"]) {
			assert.equal(fgAnsi(value as never), FG_DEFAULT);
			assert.equal(bgAnsi(value as never), BG_DEFAULT);
		}
		assert.equal(bg("#abc", "text"), "\x1b[48;2;170;187;204mtext\x1b[49m");
		assert.equal(bg("#abc", ""), "");
	});

	it("preserves hex validation and colors after bounded-cache churn", () => {
		for (const hex of ["abc", "#ABC", "a1B2c3", "#a1B2c3"]) assert.equal(isValidHex(hex), true);
		for (const hex of ["ab", "abcd", "abcde", "abcdefg", "#ggg", " abc", "abc\n"]) {
			assert.equal(isValidHex(hex), false);
			assert.deepEqual(hexToRgb(hex), { r: 0, g: 0, b: 0 });
		}
		for (let i = 0; i < 700; i++) {
			const hex = `#${i.toString(16).padStart(6, "0")}`;
			const { r, g, b } = hexToRgb(hex);
			assert.equal(fgAnsi(hex), `\x1b[38;2;${r};${g};${b}m`);
			assert.equal(bgAnsi(hex), `\x1b[48;2;${r};${g};${b}m`);
			assert.equal(fgAnsi(hex, "256color"), `\x1b[38;5;${rgbTo256(r, g, b)}m`);
			assert.equal(bgAnsi(hex, "256color"), `\x1b[48;5;${rgbTo256(r, g, b)}m`);
		}
		assert.equal(fgAnsi("#D77757"), "\x1b[38;2;215;119;87m");
		assert.equal(bgAnsi("#D77757"), "\x1b[48;2;215;119;87m");
	});

	it("fg formats text with color and resets to FG_DEFAULT", () => {
		assert.equal(fg("#D77757", ""), "");
		assert.equal(fg("#D77757", "hello"), "\x1b[38;2;215;119;87mhello\x1b[39m");
		assert.ok(fg("#D77757", "hello", "256color").includes("hello"));
	});

	it("stripAnsi removes ANSI CSI, OSC, and styling sequences cleanly", () => {
		assert.equal(stripAnsi(""), "");
		assert.equal(stripAnsi("plain text"), "plain text");
		assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
		assert.equal(stripAnsi("\x1b[38;2;215;119;87mİşleniyor…\x1b[39m"), "İşleniyor…");
		assert.equal(stripAnsi("\x1b[2m(12sn · ↓ 1.2k token)\x1b[22m"), "(12sn · ↓ 1.2k token)");
	});

	it("visibleWidth accurately computes terminal display columns ignoring ANSI", () => {
		assert.equal(visibleWidth(""), 0);
		assert.equal(visibleWidth("hello"), 5);
		assert.equal(visibleWidth("\x1b[31mhello\x1b[0m"), 5);
		assert.equal(visibleWidth("\x1b[38;2;215;119;87mİşleniyor…\x1b[39m"), 10);
		assert.equal(visibleWidth("✻"), 1);
		assert.equal(visibleWidth("↓ 1.2k token"), 12);
		assert.equal(visibleWidth("Türkçe: ğ, ü, ş, ı, ö, ç, İ, Ğ, Ü, Ş, I, Ö, Ç"), 45);

		// Zero-width diacritics and combining marks
		assert.equal(visibleWidth("café"), 4);
		assert.equal(visibleWidth("cafe\u0301"), 4); // decomposed e + acute normalized to NFC
	});

	it("measures grapheme clusters rather than individual emoji code points", () => {
		for (const text of ["👨‍👩‍👧‍👦", "🇹🇷", "👍🏽", "❤️", "✨", "가"]) {
			assert.equal(visibleWidth(text), 2, text);
			assert.equal(visibleWidth(`\x1b[31m${text}\x1b[0m`), 2, text);
		}
		assert.equal(visibleWidth("a\u202eb"), 2);
		assert.equal(visibleWidth("a\x90hidden\x9cb"), 2);
	});

	it("resolvePalette returns Claude Code Dark palette by default", () => {
		const pal = resolvePalette();
		assert.equal(pal.scheme, "dark");
		assert.equal(pal.isCcTheme, true);
		assert.equal(pal.colorMode, "truecolor");
		assert.equal(pal.cc.claude, "#D77757");
		assert.equal(pal.cc.claudeShimmer, "#EB9F7F");
	});

	it("resolvePalette detects light themes and returns Claude Code Light palette", () => {
		const lightPal = resolvePalette("claude-code-light");
		assert.equal(lightPal.scheme, "light");
		assert.equal(lightPal.isCcTheme, true);
		assert.equal(lightPal.cc.claude, "#B84E2D");
		assert.equal(lightPal.cc.claudeShimmer, "#D97757");

		const lattePal = resolvePalette("catppuccin-latte");
		assert.equal(lattePal.scheme, "light");
	});

	it("CLAUDE_CODE_DARK_PALETTE contains all essential theme tokens", () => {
		assert.equal(CLAUDE_CODE_DARK_PALETTE.claude, "#D77757");
		assert.equal(CLAUDE_CODE_DARK_PALETTE.claudeShimmer, "#EB9F7F");
		assert.equal(CLAUDE_CODE_DARK_PALETTE.autoAccept, "#AF87FF");
		assert.equal(CLAUDE_CODE_DARK_PALETTE.bashBorder, "#FD5DB1");
		assert.equal(CLAUDE_CODE_DARK_PALETTE.permission, "#B1B9F9");
		assert.equal(CLAUDE_CODE_DARK_PALETTE.planMode, "#48968C");
		assert.equal(CLAUDE_CODE_DARK_PALETTE.success, "#4EBA65");
		assert.equal(CLAUDE_CODE_DARK_PALETTE.error, "#FF6B80");
		assert.equal(CLAUDE_CODE_DARK_PALETTE.warning, "#FFC107");
	});

	it("CLAUDE_CODE_LIGHT_PALETTE contains high-contrast accessible tokens", () => {
		assert.equal(CLAUDE_CODE_LIGHT_PALETTE.claude, "#B84E2D");
		assert.equal(CLAUDE_CODE_LIGHT_PALETTE.claudeShimmer, "#D97757");
		assert.equal(CLAUDE_CODE_LIGHT_PALETTE.success, "#2E7D32");
		assert.equal(CLAUDE_CODE_LIGHT_PALETTE.error, "#C62828");
		assert.equal(CLAUDE_CODE_LIGHT_PALETTE.warning, "#E65100");
	});

	it("exports standard ANSI control constants", () => {
		assert.equal(RESET, "\x1b[0m");
		assert.equal(FG_DEFAULT, "\x1b[39m");
		assert.equal(BG_DEFAULT, "\x1b[49m");
	});
});
