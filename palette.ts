/** Theme-aware rendering helpers and standalone fallback palettes. */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getTerminalColorMode, visibleWidth as tuiVisibleWidth } from "@earendil-works/pi-tui";

export interface Rgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

export function rgb(r: number, g: number, b: number): Rgb {
	return { r, g, b };
}

/**
 * Validates if a string is a valid 3-digit or 6-digit hex color (with optional leading #).
 */
export function isValidHex(hex: string): boolean {
	if (typeof hex !== "string" || hex.length === 0) return false;
	const start = hex.charCodeAt(0) === 35 ? 1 : 0; // 35 is '#'
	const len = hex.length - start;
	if (len !== 3 && len !== 6) return false;
	for (let i = start; i < hex.length; i++) {
		const code = hex.charCodeAt(i);
		const isHex =
			(code >= 48 && code <= 57) || // 0-9
			(code >= 65 && code <= 70) || // A-F
			(code >= 97 && code <= 102); // a-f
		if (!isHex) return false;
	}
	return true;
}

export function hexToRgb(hex: string): Rgb {
	if (!isValidHex(hex)) return rgb(0, 0, 0);
	let digits = hex.startsWith("#") ? hex.slice(1) : hex;
	if (digits.length === 3) digits = digits.split("").map((digit) => digit + digit).join("");
	return rgb(
		parseInt(digits.slice(0, 2), 16),
		parseInt(digits.slice(2, 4), 16),
		parseInt(digits.slice(4, 6), 16),
	);
}

/**
 * Maps 24-bit RGB values to the nearest xterm 256-color index.
 */
export function rgbTo256(r: number, g: number, b: number): number {
	const clampByte = (v: number): number =>
		typeof v === "number" && Number.isFinite(v)
			? Math.max(0, Math.min(255, Math.floor(v)))
			: 0;
	const cr = clampByte(r);
	const cg = clampByte(g);
	const cb = clampByte(b);

	// Grayscale ramp check (232-255)
	if (cr === cg && cg === cb) {
		if (cr < 8) return 16;
		if (cr > 248) return 231;
		return Math.round(((cr - 8) / 240) * 23) + 232;
	}

	// 6x6x6 color cube: 16 + 36*r6 + 6*g6 + b6
	const toCube = (v: number): number => {
		if (v < 48) return 0;
		if (v < 115) return 1;
		return Math.min(5, Math.floor((v - 35) / 40));
	};

	return 16 + 36 * toCube(cr) + 6 * toCube(cg) + toCube(cb);
}

export type ColorValue = string | number;
export type ColorMode = "truecolor" | "256color";

/** Standalone fallback colors; active host themes supply semantic colors. */
export interface CcPalette {
	readonly claude: ColorValue;
	readonly claudeShimmer: ColorValue;
	readonly autoAccept: ColorValue;
	readonly bashBorder: ColorValue;
	readonly permission: ColorValue;
	readonly planMode: ColorValue;
	readonly promptBorder: ColorValue;
	readonly inactive: ColorValue;
	readonly subtle: ColorValue;
	readonly success: ColorValue;
	readonly error: ColorValue;
	readonly warning: ColorValue;
	readonly diffAddedBg: ColorValue;
	readonly diffRemovedBg: ColorValue;
	readonly diffAddedWord: ColorValue;
	readonly diffRemovedWord: ColorValue;
	readonly userMsgBg: ColorValue;
	readonly selectionBg: ColorValue;
	readonly bashMsgBg: ColorValue;
}

export const CLAUDE_CODE_DARK_PALETTE: CcPalette = {
	claude: "#D77757",
	claudeShimmer: "#EB9F7F",
	autoAccept: "#AF87FF",
	bashBorder: "#FD5DB1",
	permission: "#B1B9F9",
	planMode: "#48968C",
	promptBorder: "#888888",
	inactive: "#999999",
	subtle: "#505050",
	success: "#4EBA65",
	error: "#FF6B80",
	warning: "#FFC107",
	diffAddedBg: "#225C2B",
	diffRemovedBg: "#7A2936",
	diffAddedWord: "#38A660",
	diffRemovedWord: "#B3596B",
	userMsgBg: "#373737",
	selectionBg: "#264F78",
	bashMsgBg: "#413C41",
};

/** High-contrast palette for light terminal backgrounds */
export const CLAUDE_CODE_LIGHT_PALETTE: CcPalette = {
	claude: "#B84E2D",
	claudeShimmer: "#D97757",
	autoAccept: "#7C4DFF",
	bashBorder: "#C2185B",
	permission: "#5C6BC0",
	planMode: "#00796B",
	promptBorder: "#666666",
	inactive: "#767676",
	subtle: "#9E9E9E",
	success: "#2E7D32",
	error: "#C62828",
	warning: "#E65100",
	diffAddedBg: "#D7EAD9",
	diffRemovedBg: "#F7D8DC",
	diffAddedWord: "#1B5E20",
	diffRemovedWord: "#B71C1C",
	userMsgBg: "#E0E0E0",
	selectionBg: "#BBD6FB",
	bashMsgBg: "#E8E4E8",
};

export const RESET = "\x1b[0m";
export const FG_DEFAULT = "\x1b[39m";
export const BG_DEFAULT = "\x1b[49m";

// Hoisted compiled regex for comprehensive ANSI and terminal control escape sequences:
// - CSI (7-bit \x1b[ and 8-bit \x9b)
// - OSC (7-bit \x1b] and 8-bit \x9d terminated by \x07, \x1b\, \x9c, or end of string)
// - DCS / APC / PM / SOS (7-bit \x1bP/X/^_ and 8-bit \x90/\x98/\x9e/\x9f)
// - 2-byte escape sequences (\x1b followed by character in 0x20-0x7e)
// - Standalone / dangling ESC (\x1b)
export const ANSI_REGEX =
	/(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x1b\x9c\x07]*(?:\x1b\\|\x9c|\x07|$)|(?:\x1b[()#%*+\-./][^\x1b\x07]?|\x1b[A-Za-z0-9=@<>])|\x1b/g;

// Matches all C0 and C1 control characters (0x00-0x1f, 0x7f, 0x80-0x9f)
export const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f-\x9f]/g;

// Regex for stripping unsafe control characters and non-SGR escapes while preserving safe SGR sequences (\x1b[...m)
const NON_SGR_ANSI_OR_UNSAFE_CONTROLS =
	/(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[@-ln-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x1b\x9c\x07]*(?:\x1b\\|\x9c|\x07|$)|(?:\x1b[()#%*+\-./][^\x1b\x07]?|\x1b[A-Za-z0-9=@<>])|[\x00-\x1a\x1c-\x1f\x7f-\x9f]|\x1b(?![[0-9;]*m)/g;

// Precomputed 256-color number ANSI escape sequences (0-255)
const ANSI_256_NUMBERS: readonly string[] = Array.from(
	{ length: 256 },
	(_, i) =>
		i < 8 ? `\x1b[${30 + i}m` : i < 16 ? `\x1b[${82 + i}m` : `\x1b[38;5;${i}m`,
);

// Bounded fast ANSI cache for hot-path colors
const MAX_ANSI_CACHE_SIZE = 512;
const ANSI_CACHE = new Map<string, string>();

// Pre-seed cache with standard dark and light palette tokens
function preseedPalette(palette: CcPalette): void {
	for (const key of Object.keys(palette) as (keyof CcPalette)[]) {
		const val = palette[key];
		if (typeof val === "string") {
			const { r, g, b } = hexToRgb(val);
			ANSI_CACHE.set(`truecolor:${val}`, `\x1b[38;2;${r};${g};${b}m`);
			ANSI_CACHE.set(`256color:${val}`, `\x1b[38;5;${rgbTo256(r, g, b)}m`);
			ANSI_CACHE.set(`bg:truecolor:${val}`, `\x1b[48;2;${r};${g};${b}m`);
			ANSI_CACHE.set(`bg:256color:${val}`, `\x1b[48;5;${rgbTo256(r, g, b)}m`);
		}
	}
}
preseedPalette(CLAUDE_CODE_DARK_PALETTE);
preseedPalette(CLAUDE_CODE_LIGHT_PALETTE);

/** Strip ANSI and terminal control escape sequences from a string */
export function stripAnsi(text: string): string {
	if (!text || typeof text !== "string") return "";
	if (
		!text.includes("\x1b") &&
		!text.includes("\x9b") &&
		!text.includes("\x9d") &&
		!text.includes("\x90") &&
		!text.includes("\x98") &&
		!text.includes("\x9e") &&
		!text.includes("\x9f")
	) {
		return text;
	}
	return text.replace(ANSI_REGEX, "");
}

/**
 * Strips all C0 and C1 control characters (e.g. \x00-\x1f, \x7f-\x9f, \r, \n, \t, \x07, \x08).
 */
export function sanitizeControlChars(text: string): string {
	if (!text || typeof text !== "string") return "";
	let hasControl = false;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 32 || (code >= 127 && code <= 159)) {
			hasControl = true;
			break;
		}
	}
	if (!hasControl) return text;
	return text.replace(CONTROL_CHARS_REGEX, "");
}

/**
 * Sanitizes terminal window/tab titles against terminal injection attacks.
 * Strips all ANSI sequences, control characters, newlines, and collapses spaces.
 */
export function sanitizeTitle(title: string): string {
	if (!title || typeof title !== "string") return "";
	const clean = stripAnsi(title)
		.replace(/[\x00-\x1f\x7f-\x9f\s]+/g, " ")
		.trim();
	return clean.normalize("NFC");
}

/**
 * Sanitizes a formatted terminal string by stripping all unsafe escape sequences
 * (OSC, DCS, APC, PM, cursor movement, clears) and raw control characters (newlines, bells),
 * while preserving safe SGR styling escape sequences (\x1b[...m).
 */
export function sanitizeSafeAnsi(text: string): string {
	if (!text || typeof text !== "string") return "";
	if (
		!text.includes("\x1b") &&
		!text.includes("\x9b") &&
		!text.includes("\x9d") &&
		!text.includes("\x90") &&
		!text.includes("\x98") &&
		!text.includes("\x9e") &&
		!text.includes("\x9f")
	) {
		let hasControl = false;
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i);
			if (code < 32 || (code >= 127 && code <= 159)) {
				hasControl = true;
				break;
			}
		}
		if (!hasControl) return text;
	}
	return text.replace(NON_SGR_ANSI_OR_UNSAFE_CONTROLS, "");
}

const MAX_WIDTH_CACHE_SIZE = 512;
const WIDTH_CACHE = new Map<string, number>();

/** Fast path for Latin text and combining accents; other scripts use Pi's grapheme widths. */
function simpleWidth(text: string): number | undefined {
	let width = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code < 0x0300)) {
			if (code !== 0x00ad) width++;
		} else if ((code < 0x20 && code !== 0x1b) || code === 0x7f || (code >= 0x0300 && code <= 0x036f)) {
			continue;
		} else {
			return undefined;
		}
	}
	return width;
}

/** Measures terminal columns without replaying controls or splitting grapheme clusters. */
export function visibleWidth(str: string): number {
	if (!str || typeof str !== "string") return 0;
	const cached = WIDTH_CACHE.get(str);
	if (cached !== undefined) return cached;
	const simple = simpleWidth(str);
	if (simple !== undefined) return simple;

	// Pi handles graphemes; our sanitizer additionally removes C1/DCS payloads.
	const clean = sanitizeControlChars(stripAnsi(str));
	const width = simpleWidth(clean) ?? tuiVisibleWidth(clean);
	if (WIDTH_CACHE.size >= MAX_WIDTH_CACHE_SIZE) {
		const oldest = WIDTH_CACHE.keys().next().value;
		if (oldest !== undefined) WIDTH_CACHE.delete(oldest);
	}
	WIDTH_CACHE.set(str, width);
	return width;
}

/** Shared hex encoding; numeric foreground/background forms intentionally differ. */
function hexColorAnsi(color: string, mode: ColorMode, background: boolean): string {
	const fallback = background ? BG_DEFAULT : FG_DEFAULT;
	if (!isValidHex(color)) return fallback;
	const safeMode = mode === "256color" ? "256color" : "truecolor";
	const cacheKey = `${background ? "bg:" : ""}${safeMode}:${color}`;
	const hit = ANSI_CACHE.get(cacheKey);
	if (hit !== undefined) return hit;

	const { r, g, b } = hexToRgb(color);
	const code = background ? 48 : 38;
	const ansi = safeMode === "256color"
		? `\x1b[${code};5;${rgbTo256(r, g, b)}m`
		: `\x1b[${code};2;${r};${g};${b}m`;
	if (ANSI_CACHE.size >= MAX_ANSI_CACHE_SIZE) {
		ANSI_CACHE.clear();
		preseedPalette(CLAUDE_CODE_DARK_PALETTE);
		preseedPalette(CLAUDE_CODE_LIGHT_PALETTE);
	}
	ANSI_CACHE.set(cacheKey, ansi);
	return ansi;
}

export function fgAnsi(
	color: ColorValue,
	mode: ColorMode = "truecolor",
): string {
	if (typeof color === "number") {
		if (!Number.isFinite(color) || color < 0 || color > 255) return FG_DEFAULT;
		return ANSI_256_NUMBERS[Math.floor(color)] ?? FG_DEFAULT;
	}
	return typeof color === "string" ? hexColorAnsi(color, mode, false) : FG_DEFAULT;
}

export function fg(
	color: ColorValue,
	text: string,
	mode: ColorMode = "truecolor",
): string {
	if (typeof text !== "string" || text === "") return "";
	return `${fgAnsi(color, mode)}${text}${FG_DEFAULT}`;
}

export function bgAnsi(
	color: ColorValue,
	mode: ColorMode = "truecolor",
): string {
	if (typeof color === "number") {
		if (!Number.isFinite(color) || color < 0 || color > 255) return BG_DEFAULT;
		return `\x1b[48;5;${Math.floor(color)}m`;
	}
	return typeof color === "string" ? hexColorAnsi(color, mode, true) : BG_DEFAULT;
}

export function bg(
	color: ColorValue,
	text: string,
	mode: ColorMode = "truecolor",
): string {
	if (typeof text !== "string" || text === "") return "";
	return `${bgAnsi(color, mode)}${text}${BG_DEFAULT}`;
}

let themeFallbackWarningLogged = false;

/** Host appearance takes precedence over legacy name-only fallback detection. */
export function resolveThemeAppearance(theme?: Theme | { name?: string }): "dark" | "light" {
	if (theme && "appearance" in theme && (theme.appearance === "dark" || theme.appearance === "light")) {
		return theme.appearance;
	}
	return resolvePalette(theme?.name).scheme;
}

/** Use the host's encoding, including 256-color terminals. */
export function resolveThemeColorMode(theme?: Theme | { name?: string }): ColorMode {
	return theme && "getColorMode" in theme && typeof theme.getColorMode === "function"
		? theme.getColorMode() : getTerminalColorMode();
}

/** Theme calls are a UI boundary; a broken host painter must not break status rendering. */
export function themeText(
	theme: Theme | undefined,
	role: ThemeColor,
	text: string,
	fallback: (text: string) => string,
): string {
	if (theme && typeof theme.fg === "function") {
		try {
			const painted = theme.fg(role, text);
			if (typeof painted === "string" && painted.includes(text)) return painted;
		} catch {
			// Report once below; do not include possibly sensitive theme payloads.
		}
		if (!themeFallbackWarningLogged) {
			themeFallbackWarningLogged = true;
			console.warn("[arda-pi-ui] Theme painter unavailable; using fallback status colors.");
		}
	}
	return fallback(text);
}

export interface ResolvedPalette {
	readonly cc: CcPalette;
	readonly scheme: "dark" | "light";
	readonly isCcTheme: true;
	readonly colorMode: ColorMode;
}

/**
 * Resolves the palette based on theme name (dark vs light).
 */
export function resolvePalette(
	themeName?: string,
	_tokenFg?: (token: string) => string | undefined,
): ResolvedPalette {
	const isLight =
		typeof themeName === "string" &&
		/light|latte|day|dawn|white/i.test(themeName);
	return {
		cc: isLight ? CLAUDE_CODE_LIGHT_PALETTE : CLAUDE_CODE_DARK_PALETTE,
		scheme: isLight ? "light" : "dark",
		isCcTheme: true,
		colorMode: "truecolor",
	};
}
