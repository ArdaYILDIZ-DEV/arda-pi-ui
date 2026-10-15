/** Pure cache formatting and standalone widget layout. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, styleText, truncateToWidth } from "@earendil-works/pi-tui";
import { type ColorMode, type Rgb, rgb, rgbTo256, visibleWidth, sanitizeControlChars, stripAnsi, resolveThemeAppearance, resolveThemeColorMode } from "./palette.ts";
import { DEFAULT_UNKNOWN_CACHE_TTL_MS, type PromptCacheObservation } from "./prompt-cache.ts";

export const DEFAULT_CACHE_TTL_MS = DEFAULT_UNKNOWN_CACHE_TTL_MS;

export interface ColorStop {
	readonly ratio: number; // 0.0 to 1.0
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

/**
 * Color ramp for dark terminal backgrounds.
 * Transitions from fresh green to yellow, orange, bright red,
 * and darkens into deep crimson red as it approaches 5 minutes (300s).
 */
export const DARK_CACHE_STOPS: readonly ColorStop[] = [
	{ ratio: 0.0, r: 78, g: 186, b: 101 }, // #4EBA65 (fresh green)
	{ ratio: 0.35, r: 180, g: 205, b: 50 }, // lime / yellow-green
	{ ratio: 0.6, r: 255, g: 193, b: 7 }, // #FFC107 (amber yellow)
	{ ratio: 0.8, r: 240, g: 105, b: 35 }, // warning orange
	{ ratio: 0.92, r: 235, g: 50, b: 50 }, // vibrant danger red
	{ ratio: 1.0, r: 140, g: 18, b: 18 }, // deep dark crimson red ("koyulaşsın kırmızıya doğru")
];

/**
 * Color ramp for light terminal backgrounds.
 */
export const LIGHT_CACHE_STOPS: readonly ColorStop[] = [
	{ ratio: 0.0, r: 46, g: 125, b: 50 }, // deep green
	{ ratio: 0.35, r: 130, g: 150, b: 20 }, // dark lime
	{ ratio: 0.6, r: 205, g: 130, b: 0 }, // dark amber
	{ ratio: 0.8, r: 215, g: 75, b: 20 }, // dark orange
	{ ratio: 0.92, r: 195, g: 30, b: 30 }, // dark red
	{ ratio: 1.0, r: 105, g: 15, b: 15 }, // deep crimson
];

/**
 * Linearly interpolates between two RGB colors.
 */
export function interpolateRgb(a: Rgb, b: Rgb, factor: number): Rgb {
	const f = Math.max(0, Math.min(1, Number.isFinite(factor) ? factor : 0));
	return rgb(
		Math.round(a.r + (b.r - a.r) * f),
		Math.round(a.g + (b.g - a.g) * f),
		Math.round(a.b + (b.b - a.b) * f),
	);
}

/**
 * Computes the interpolated RGB color for a given TTL ratio (0.0 to 1.0+).
 */
export function getCacheColor(
	ratio: number,
	scheme: "dark" | "light" = "dark",
): Rgb {
	const stops = scheme === "light" ? LIGHT_CACHE_STOPS : DARK_CACHE_STOPS;
	const safeRatio =
		typeof ratio === "number" && Number.isFinite(ratio) ? ratio : 0;
	if (safeRatio <= 0) return rgb(stops[0]!.r, stops[0]!.g, stops[0]!.b);
	if (safeRatio >= 1) {
		const last = stops[stops.length - 1]!;
		return rgb(last.r, last.g, last.b);
	}

	for (let i = 0; i < stops.length - 1; i++) {
		const curr = stops[i]!;
		const next = stops[i + 1]!;
		if (safeRatio >= curr.ratio && safeRatio <= next.ratio) {
			const span = next.ratio - curr.ratio;
			const factor = span > 0 ? (safeRatio - curr.ratio) / span : 0;
			return interpolateRgb(curr, next, factor);
		}
	}
	const last = stops[stops.length - 1]!;
	return rgb(last.r, last.g, last.b);
}

/** Shared semantic TTL ramp for the footer and standalone widget. */
export function cacheTtlText(text: string, ratio: number, theme?: Theme): string {
	const safeText = sanitizeControlChars(stripAnsi(text));
	const safeRatio = getCacheTtlRatio(ratio, 1);
	const mode = resolveThemeColorMode(theme);
	try {
		const colors = theme?.colors;
		if (colors?.success && colors.warning && colors.error) {
			const color = safeRatio <= 0.6
				? mixColors(colors.success, colors.warning, safeRatio / 0.6, "srgb")
				: mixColors(colors.warning, colors.error, (safeRatio - 0.6) / 0.4, "srgb");
			return styleText(safeText, { fg: color }, mode);
		}
	} catch {
		// Partial/legacy host themes still need a readable timer.
	}
	return colorizeRgb(safeText, getCacheColor(safeRatio, resolveThemeAppearance(theme)), mode);
}

/**
 * Formats an RGB color into an ANSI SGR escape sequence.
 */
export function rgbToAnsi(
	r: number,
	g: number,
	b: number,
	mode: ColorMode = "truecolor",
): string {
	const safeR = Math.max(
		0,
		Math.min(255, Number.isFinite(r) ? Math.floor(r) : 0),
	);
	const safeG = Math.max(
		0,
		Math.min(255, Number.isFinite(g) ? Math.floor(g) : 0),
	);
	const safeB = Math.max(
		0,
		Math.min(255, Number.isFinite(b) ? Math.floor(b) : 0),
	);

	if (mode === "256color") {
		return `\x1b[38;5;${rgbTo256(safeR, safeG, safeB)}m`;
	}
	return `\x1b[38;2;${safeR};${safeG};${safeB}m`;
}

/**
 * Wraps text with RGB foreground color and ANSI reset.
 */
export function colorizeRgb(
	text: string,
	color: Rgb,
	mode: ColorMode = "truecolor",
): string {
	if (!text || typeof text !== "string") return "";
	return `${rgbToAnsi(color.r, color.g, color.b, mode)}${text}\x1b[39m`;
}

/**
 * Formats elapsed milliseconds into natural Turkish time string (e.g. "45sn", "1dk 15sn", "1sa 2dk 5sn").
 */
export function formatCacheElapsed(ms: number): string {
	const safe =
		typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : 0;
	const totalSec = Math.floor(safe / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}sa ${m}dk ${s}sn`;
	if (m > 0) return `${m}dk ${s}sn`;
	return `${s}sn`;
}

/**
 * Formats remaining milliseconds until TTL expiration into natural Turkish time string.
 */
export function formatCacheRemaining(
	elapsedMs: number,
	ttlMs: number = DEFAULT_CACHE_TTL_MS,
): string {
	const safeElapsed =
		typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0
			? Math.floor(elapsedMs)
			: 0;
	const safeTtl =
		typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0
			? Math.floor(ttlMs)
			: DEFAULT_CACHE_TTL_MS;
	const remMs = Math.max(0, safeTtl - safeElapsed);
	const totalSec = Math.floor(remMs / 1000);
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	if (m > 0) return `${m}dk ${s}sn`;
	return `${s}sn`;
}

/**
 * Computes TTL ratio (clamped to 0.0 .. 1.0).
 */
export function getCacheTtlRatio(
	elapsedMs: number,
	ttlMs: number = DEFAULT_CACHE_TTL_MS,
): number {
	const safeElapsed =
		typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0
			? elapsedMs
			: 0;
	const safeTtl =
		typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0
			? ttlMs
			: DEFAULT_CACHE_TTL_MS;
	return Math.min(1, safeElapsed / safeTtl);
}

// ---------------------------------------------------------------------------
// Pure line builder (tested in isolation)
// ---------------------------------------------------------------------------

export interface CacheTimerFrameState {
	readonly elapsedMs: number;
	readonly ttlMs?: number;
	readonly columns: number;
	readonly hasContext: boolean;
	readonly isProcessing: boolean;
	readonly gitSummary?: string | null;
	/** Already qualified provider observation; omitted for the standalone local reminder. */
	readonly badgeText?: string;
}

export interface CacheTimerPaint {
	readonly colorize: (text: string, color: Rgb) => string;
	/** Semantic success → warning → error ramp supplied by the host theme. */
	readonly ttlColor?: (text: string, ratio: number) => string;
	readonly dim: (text: string) => string;
	readonly accent: (text: string) => string;
	readonly red: (text: string) => string;
	readonly scheme: "dark" | "light";
	readonly colorMode: ColorMode;
}

/**
 * Builds the Cache TTL counter line for display immediately below the editor.
 *
 * Minimal right-aligned format requested by user:
 * `                                                                     36sn / 5dk`
 *
 * The timer portion is colored according to proximity to 5 minutes (green -> yellow ->
 * orange -> danger red -> deep crimson red), and `/ 5dk` is dimmed.
 */
export function buildCacheTimerLine(
	state: CacheTimerFrameState,
	paint: CacheTimerPaint,
): string {
	if (!state || (!state.hasContext && !state.gitSummary)) {
		return "";
	}

	const rawCols =
		typeof state.columns === "number" && Number.isFinite(state.columns)
			? state.columns
			: 80;
	const cols = Math.max(0, Math.floor(rawCols));
	// Pi's Text component in widgets applies paddingX: 1 (1 char margin left and right)
	const availableWidth = Math.max(1, cols - 2);

	const rawGit =
		typeof state.gitSummary === "string" ? sanitizeControlChars(stripAnsi(state.gitSummary)).trim() : "";
	const hasGit = rawGit.length > 0;

	// Case 1: No context yet (new session before first request), but gitSummary is present
	if (!state.hasContext) {
		if (!hasGit) return "";
		if (availableWidth < visibleWidth(rawGit)) {
			return paint.dim(truncateToWidth(rawGit, availableWidth));
		}
		return paint.dim(rawGit);
	}

	const ttlMs =
		typeof state.ttlMs === "number" &&
		Number.isFinite(state.ttlMs) &&
		state.ttlMs > 0
			? state.ttlMs
			: DEFAULT_CACHE_TTL_MS;
	const elapsedMs =
		typeof state.elapsedMs === "number" &&
		Number.isFinite(state.elapsedMs) &&
		state.elapsedMs >= 0
			? Math.floor(state.elapsedMs)
			: 0;

	const effectiveElapsed = state.isProcessing ? 0 : elapsedMs;
	const ratio = getCacheTtlRatio(effectiveElapsed, ttlMs);
	const color = getCacheColor(ratio, paint.scheme);
	const elapsedText = formatCacheElapsed(effectiveElapsed);

	const paintElapsed = (text: string) => paint.ttlColor ? paint.ttlColor(text, ratio) : paint.colorize(text, color);
	const ttlText = formatCacheElapsed(ttlMs).replace(" 0sn", "");
	const badgeText = typeof state.badgeText === "string" ? sanitizeControlChars(stripAnsi(state.badgeText)) : undefined;
	const rawBadge = badgeText ?? `${elapsedText} / ${ttlText}`;
	const fullBadge = badgeText !== undefined ? paint.dim(badgeText)
		: `${paintElapsed(elapsedText)} ${paint.dim("/")} ${paint.red(ttlText)}`;
	const badgeWidth = visibleWidth(rawBadge);

	// Progressive fallback if available width cannot fit "XXsn / 5dk"
	if (availableWidth < badgeWidth) {
		if (badgeText !== undefined) return paint.dim(truncateToWidth(badgeText, availableWidth));
		const shortWidth = visibleWidth(elapsedText);
		if (availableWidth >= shortWidth) {
			const pad = Math.max(0, availableWidth - shortWidth);
			return " ".repeat(pad) + paintElapsed(elapsedText);
		}
		const trunc = truncateToWidth(elapsedText, availableWidth);
		return paintElapsed(trunc);
	}

	// When git summary is also present, format dual layout: git on left, TTL on right
	if (hasGit) {
		const gitWidth = visibleWidth(rawGit);
		if (availableWidth >= gitWidth + badgeWidth + 2) {
			const pad = availableWidth - gitWidth - badgeWidth;
			return paint.dim(rawGit) + " ".repeat(pad) + fullBadge;
		}

		if (availableWidth >= badgeWidth + 8) {
			const maxGitWidth = availableWidth - badgeWidth - 2;
			const fittedGit = truncateToWidth(rawGit, maxGitWidth);
			const pad = availableWidth - visibleWidth(fittedGit) - badgeWidth;
			return paint.dim(fittedGit) + " ".repeat(pad) + fullBadge;
		}
	}

	const pad = Math.max(0, availableWidth - badgeWidth);
	return " ".repeat(pad) + fullBadge;
}

/** Age since a cache-bearing request, compared with a best-effort window, not expiry. */
export function formatPromptCacheObservation(observation: PromptCacheObservation): string {
	if (observation.timestamp === undefined) return "";
	const age = formatCacheElapsed(Math.max(0, Date.now() - observation.timestamp));
	const label = observation.source === "warm" ? "warm age ~" : "age ";
	return `${label}${age}${observation.ttlMs ? ` / ~${formatCacheElapsed(observation.ttlMs).replace(" 0sn", "")}${observation.ttlSource === "fallback" ? "*" : ""}` : " / ttl ?"}`;
}
