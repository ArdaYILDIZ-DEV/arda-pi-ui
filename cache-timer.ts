/**
 * Recorded provider cache usage and qualified request-age observations.
 * The footer owns presentation; standalone callers retain a local reminder.
 * Neither request age nor a requested lifetime is proof of a live server cache.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	Theme,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import {
	type ColorMode,
	type Rgb,
	rgb,
	rgbTo256,
	resolvePalette,
	resolveThemeAppearance,
	resolveThemeColorMode,
	themeText,
	fg as paletteFg,
	visibleWidth,
	sanitizeControlChars,
	stripAnsi,
} from "./palette.ts";
import { notifySafely } from "./pi-compat.ts";
import { DEFAULT_UNKNOWN_CACHE_TTL_MS, PromptCacheTracker, type CacheEntry, type CacheModel, type PromptCacheObservation } from "./prompt-cache.ts";

let truncationWarningLogged = false;

function warnTruncationFallback(error?: unknown): void {
	if (truncationWarningLogged) return;
	truncationWarningLogged = true;
	console.warn("[arda-pi-ui] Pi text truncation unavailable; using plain text.", error);
}

function truncateToWidth(text: string, width: number): string {
	if (typeof PiTui.truncateToWidth === "function") {
		try {
			const truncated = PiTui.truncateToWidth(text, width);
			if (typeof truncated === "string") return truncated;
			warnTruncationFallback();
		} catch (error) {
			warnTruncationFallback(error);
		}
	} else {
		warnTruncationFallback();
	}

	const maxWidth = Math.max(0, Math.floor(width));
	let output = "";
	let usedWidth = 0;
	for (const character of stripAnsi(text)) {
		const characterWidth = visibleWidth(character);
		if (usedWidth + characterWidth > maxWidth) break;
		output += character;
		usedWidth += characterWidth;
	}
	return output;
}

export const DEFAULT_CACHE_TTL_MS = DEFAULT_UNKNOWN_CACHE_TTL_MS;
/** Change one tuple for every provider/window; ratios must increase strictly within (0, 1). */
export const DEFAULT_CACHE_SOUND_RATIOS: readonly [number, number, number] = [0.5, 0.8, 0.9];

// Widget render failures tolerated in a row before the 1s loop stops itself.
// A single transient UI error (teardown race) must not freeze the widget or
// silence milestone sounds; lifecycle events restart the loop via startLoop.
const MAX_CONSECUTIVE_WIDGET_ERRORS = 5;

// ---------------------------------------------------------------------------
// Audio notification milestones & playback helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CacheSoundMilestone {
	readonly id: string;
	readonly elapsedMs: number;
	readonly soundFile: string;
	readonly repeat: number;
	readonly description: string;
}

/**
 * Cache TTL audio warning milestones:
 * - Sürenin yarısı (5dk için 150s): 3.mp3 (1 kez)
 * - 4. dakika (240s): 4.mp3 (1 kez)
 * - 4.30. dakika (270s): 4.mp3 (2 kez)
 */
export const CACHE_SOUND_MILESTONES: readonly CacheSoundMilestone[] = [
	{
		id: "m3",
		elapsedMs: DEFAULT_CACHE_TTL_MS * DEFAULT_CACHE_SOUND_RATIOS[0],
		soundFile: "3.mp3",
		repeat: 1,
		description: "Sürenin yarısı uyarısı",
	},
	{
		id: "m4",
		elapsedMs: DEFAULT_CACHE_TTL_MS * DEFAULT_CACHE_SOUND_RATIOS[1],
		soundFile: "4.mp3",
		repeat: 1,
		description: "%80 uyarısı",
	},
	{
		id: "m4_30",
		elapsedMs: DEFAULT_CACHE_TTL_MS * DEFAULT_CACHE_SOUND_RATIOS[2],
		soundFile: "4.mp3",
		repeat: 2,
		description: "%90 uyarısı (2 kez)",
	},
];

export type SoundPlayerFn = (filePath: string, repeat?: number) => void;

/**
 * Resolves the absolute path of a sound file inside arda-pi-ui/sounds or arda-pi-ui root.
 */
export function resolveSoundPath(filename: string): string | null {
	if (!filename || typeof filename !== "string") return null;
	const inSounds = path.join(__dirname, "sounds", filename);
	if (fs.existsSync(inSounds)) return inSounds;
	const inRoot = path.join(__dirname, filename);
	if (fs.existsSync(inRoot)) return inRoot;
	return null;
}

let cachedAudioPlayer: {
	cmd: string;
	type: "mpv" | "ffplay" | "afplay";
} | null = null;

/**
 * Detects an available CLI audio player on the system (mpv, ffplay, afplay).
 */
export function detectAudioPlayer(): {
	cmd: string;
	type: "mpv" | "ffplay" | "afplay";
} | null {
	if (cachedAudioPlayer !== null) {
		return cachedAudioPlayer;
	}

	if (process.platform === "darwin") {
		cachedAudioPlayer = { cmd: "afplay", type: "afplay" };
		return cachedAudioPlayer;
	}

	const isWin = process.platform === "win32";
	const checkCmd = isWin ? "where" : "which";

	for (const candidate of ["mpv", "ffplay"] as const) {
		try {
			const res = spawnSync(checkCmd, [candidate], { stdio: "ignore" });
			if (res.status === 0) {
				cachedAudioPlayer = { cmd: candidate, type: candidate };
				return cachedAudioPlayer;
			}
		} catch {
			/* ignore probe failures */
		}
	}

	// Negative results are NOT cached: a missing player at first probe (minimal
	// PATH, player installed later) must not silence warnings forever. Probes
	// are single `which` calls and cheap enough to repeat per playback.
	return null;
}

/**
 * Plays an audio file in the background without blocking or writing to terminal stdio.
 */
export function playAudio(filePath: string, repeat: number = 1): void {
	if (!filePath || typeof filePath !== "string") return;
	try {
		if (!fs.existsSync(filePath)) return;
	} catch {
		return;
	}

	const player = detectAudioPlayer();
	if (!player) return;

	try {
		const repeatCount = Math.max(
			1,
			Math.floor(Number.isFinite(repeat) ? repeat : 1),
		);
		let args: string[] = [];

		if (player.type === "mpv") {
			args = ["--no-config", "--no-video", "--really-quiet"];
			for (let i = 0; i < repeatCount; i++) {
				args.push(filePath);
			}
		} else if (player.type === "ffplay") {
			args = ["-nodisp", "-autoexit", "-loglevel", "quiet"];
			if (repeatCount > 1) {
				args.push("-loop", String(repeatCount));
			}
			args.push(filePath);
		} else if (player.type === "afplay") {
			args = [filePath];
		}

		const proc = spawn(player.cmd, args, {
			stdio: "ignore",
			detached: true,
		});
		proc.on("error", () => {
			/* prevent unhandled error crashes */
		});
		proc.unref();

		// For afplay where loop flag isn't supported, trigger subsequent play sequentially
		if (player.type === "afplay" && repeatCount > 1) {
			proc.on("exit", () => {
				try {
					playAudio(filePath, repeatCount - 1);
				} catch {
					/* ignore */
				}
			});
		}
	} catch {
		/* best-effort sound playback */
	}
}

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

// ---------------------------------------------------------------------------
// Controller & Lifecycle Management
// ---------------------------------------------------------------------------

export type UiCtx = Pick<ExtensionContext, "hasUI" | "ui"> & {
	readonly model?: CacheModel;
	readonly sessionManager?: SessionManagerLike;
};

export interface SessionManagerLike {
	getEntries?(): readonly CacheEntry[];
	getBranch?(): readonly CacheEntry[];
	getSessionId?(): string;
	getLeafId?(): string | null;
}

/** Age since a cache-bearing request, compared with a best-effort window, not expiry. */
export function formatPromptCacheObservation(observation: PromptCacheObservation): string {
	if (observation.timestamp === undefined) return "";
	const age = formatCacheElapsed(Math.max(0, Date.now() - observation.timestamp));
	const label = observation.source === "warm" ? "warm age ~" : "age ";
	return `${label}${age}${observation.ttlMs ? ` / ~${formatCacheElapsed(observation.ttlMs).replace(" 0sn", "")}${observation.ttlSource === "fallback" ? "*" : ""}` : " / ttl ?"}`;
}

export interface CacheTimerStateSnapshot {
	readonly lastContextTimestamp: number | null;
	readonly isProcessing: boolean;
	readonly isVisible: boolean;
	readonly isSoundEnabled: boolean;
	readonly elapsedMs: number;
	readonly ratio: number;
	readonly isExpired: boolean;
	readonly hasTimer: boolean;
}

export interface CacheTimerOptions {
	readonly ttlMs?: number;
	readonly soundMilestoneRatios?: readonly [number, number, number];
	readonly soundEnabled?: boolean;
	readonly soundPlayer?: SoundPlayerFn;
	readonly gitInfoProvider?: () => string | null;
}

export class CacheTimerController {
	private timer: ReturnType<typeof setInterval> | null = null;
	private lastContextTimestamp: number | null = null;
	private isProcessing = false;
	private isVisible = true;
	private isSoundEnabled = true;
	private soundPlayer: SoundPlayerFn = playAudio;
	private gitInfoProvider: (() => string | null) | null = null;
	private readonly firedMilestones = new Set<string>();
	private consecutiveWidgetErrors = 0;
	private cachedTheme: Theme | undefined;
	private cachedPaint: CacheTimerPaint | null = null;
	private readonly ttlMs: number = DEFAULT_CACHE_TTL_MS;
	private readonly soundMilestoneRatios: readonly [number, number, number];
	private lastCtx: UiCtx | null = null;
	private footerRenderer: (() => void) | null = null;
	private readonly promptCache = new PromptCacheTracker();
	private observationCache?: { manager: SessionManagerLike; key: string; value: PromptCacheObservation };

	constructor(
		ttlMsOrOptions?: number | CacheTimerOptions,
		maybeOptions?: CacheTimerOptions,
	) {
		const opts: CacheTimerOptions =
			typeof ttlMsOrOptions === "object" && ttlMsOrOptions !== null
				? ttlMsOrOptions
				: (maybeOptions ?? {});
		const rawTtl =
			typeof ttlMsOrOptions === "number" ? ttlMsOrOptions : opts.ttlMs;
		this.ttlMs =
			typeof rawTtl === "number" && Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : DEFAULT_CACHE_TTL_MS;
		const ratios = opts.soundMilestoneRatios;
		this.soundMilestoneRatios = ratios?.length === 3 && ratios.every((ratio, index) =>
			Number.isFinite(ratio) && ratio > 0 && ratio < 1 && (index === 0 || ratio > ratios[index - 1]),
		) ? [...ratios] : DEFAULT_CACHE_SOUND_RATIOS;
		this.isSoundEnabled = opts.soundEnabled ?? true;
		if (typeof opts.soundPlayer === "function") {
			this.soundPlayer = opts.soundPlayer;
		}
		if (typeof opts.gitInfoProvider === "function") {
			this.gitInfoProvider = opts.gitInfoProvider;
		}
	}

	public getGitInfoProvider(): (() => string | null) | null {
		return this.gitInfoProvider;
	}

	public setGitInfoProvider(provider: (() => string | null) | null): void {
		this.gitInfoProvider = typeof provider === "function" ? provider : null;
	}

	public getTtlMs(): number {
		return this.ttlMs;
	}

	/** Share the timer with the footer while retaining audio and /cache controls. */
	public setFooterRenderer(renderer: (() => void) | null, ctx?: UiCtx): void {
		this.footerRenderer = renderer;
		if (renderer && ctx?.hasUI) {
			ctx.ui.setWidget("cache-timer", undefined, { placement: "belowEditor" });
		}
	}

	public isAudioEnabled(): boolean {
		return this.isSoundEnabled;
	}

	public setSoundEnabled(enabled: boolean): void {
		this.isSoundEnabled = Boolean(enabled);
	}

	public toggleSound(): boolean {
		this.isSoundEnabled = !this.isSoundEnabled;
		return this.isSoundEnabled;
	}

	public setSoundPlayer(player: SoundPlayerFn): void {
		this.soundPlayer = typeof player === "function" ? player : playAudio;
	}

	public resetMilestones(): void {
		this.firedMilestones.clear();
	}

	public seedMilestones(initialElapsedMs: number, ttlMs = this.ttlMs): void {
		this.firedMilestones.clear();
		if (!Number.isFinite(initialElapsedMs) || initialElapsedMs <= 0) return;
		for (const [index, milestone] of CACHE_SOUND_MILESTONES.entries()) {
			if (initialElapsedMs >= ttlMs * this.soundMilestoneRatios[index]) {
				this.firedMilestones.add(milestone.id);
			}
		}
	}

	public checkSoundMilestones(elapsedMs: number, ttlMs = this.ttlMs): void {
		if (
			!this.isSoundEnabled ||
			this.isProcessing ||
			this.lastContextTimestamp === null
		) {
			return;
		}

		for (const [index, milestone] of CACHE_SOUND_MILESTONES.entries()) {
			if (
				elapsedMs >= ttlMs * this.soundMilestoneRatios[index] &&
				!this.firedMilestones.has(milestone.id)
			) {
				this.firedMilestones.add(milestone.id);
				this.playMilestoneSound(milestone.soundFile, milestone.repeat);
			}
		}
	}

	public playMilestoneSound(filename: string, repeat: number = 1): void {
		if (!this.isSoundEnabled) return;
		const resolvedPath = resolveSoundPath(filename);
		if (!resolvedPath) return;
		try {
			this.soundPlayer(resolvedPath, repeat);
		} catch {
			/* best-effort sound notification */
		}
	}

	public getLastContextTimestamp(): number | null {
		return this.lastContextTimestamp;
	}

	public setLastContextTimestamp(ts: number | null): void {
		const valid =
			typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? ts : null;
		if (this.lastContextTimestamp !== valid) {
			this.lastContextTimestamp = valid;
			this.resetMilestones();
		}
	}

	public isWidgetVisible(): boolean {
		return this.isVisible;
	}

	public setVisible(visible: boolean, ctx?: UiCtx): void {
		this.isVisible = Boolean(visible);
		const targetCtx = ctx ?? this.lastCtx;
		if (targetCtx) {
			this.repaint(targetCtx);
		}
	}

	public toggleVisibility(ctx?: UiCtx): boolean {
		this.isVisible = !this.isVisible;
		const targetCtx = ctx ?? this.lastCtx;
		if (targetCtx) {
			this.repaint(targetCtx);
		}
		return this.isVisible;
	}

	public getState(): CacheTimerStateSnapshot {
		const now = Date.now();
		const elapsedMs =
			this.lastContextTimestamp === null
				? 0
				: Math.max(0, now - this.lastContextTimestamp);
		const ratio = getCacheTtlRatio(elapsedMs, this.ttlMs);
		return {
			lastContextTimestamp: this.lastContextTimestamp,
			isProcessing: this.isProcessing,
			isVisible: this.isVisible,
			isSoundEnabled: this.isSoundEnabled,
			elapsedMs,
			ratio,
			isExpired: elapsedMs >= this.ttlMs,
			hasTimer: this.timer !== null,
		};
	}

	public getCacheObservation(ctx: UiCtx | null = this.lastCtx): PromptCacheObservation {
		const manager = ctx?.sessionManager;
		const model = ctx?.model;
		if (!manager?.getSessionId || !manager.getLeafId) return this.promptCache.observe(model, manager?.getBranch?.());
		const key = `${manager.getSessionId()}:${manager.getLeafId()}:${model?.provider}:${model?.id}:${model?.api}:${model?.promptCache?.short}:${model?.promptCache?.long}`;
		if (this.observationCache?.manager === manager && this.observationCache.key === key) return this.observationCache.value;
		const value = this.promptCache.observe(model, manager.getBranch?.());
		this.observationCache = { manager, key, value };
		return value;
	}

	public getStatusSummary(): string {
		if (this.lastCtx?.model) {
			const observation = this.getCacheObservation();
			const usage = observation.usage;
			const actual = observation.readPercent === undefined ? "Cache read: bilinmiyor."
				: `Son istek cache read: %${Math.round(observation.readPercent)} (${usage!.cacheRead} read, ${usage!.cacheWrite} write, ${usage!.input} uncached token).`;
			const age = formatPromptCacheObservation(observation);
			const warm = observation.warmUsage;
			const warmText = warm ? `Pi warm: ${warm.cacheRead} read, ${warm.cacheWrite} write token. ` : "";
			return `${actual} ${warmText}${age ? `${age}. ` : ""}${observation.reason} TTL, erişilebilir bir sunucu cache durumu değil; istek/katalog tahminidir. Ek istek gönderilmez. Keep-alive için Pi /session ve cacheWarming ayarını kullan. Sesli uyarı: ${this.isSoundEnabled ? "açık" : "kapalı"} (eşikler: ${this.soundMilestoneRatios.map((ratio) => `%${Math.round(ratio * 100)}`).join(", ")}; * = bilinmeyen ömür için 5dk varsayılan).`;
		}
		const soundText = this.isSoundEnabled
			? `Sesli uyarı: açık (${this.soundMilestoneRatios.map((ratio) => `%${Math.round(ratio * 100)}`).join(", ")})`
			: "Sesli uyarı: kapalı";
		const ttlText = formatCacheElapsed(this.ttlMs);
		const note = "Bu yerel hatırlatıcı sağlayıcının cache durumunu göstermez.";
		if (this.isProcessing) return `Önbellek: İşleniyor (0sn / ${ttlText}). ${note} ${soundText}.`;
		if (this.lastContextTimestamp === null) {
			return `Önbellek: Henüz istek gönderilmedi (yeni oturum). ${soundText}.`;
		}
		const elapsedMs = Math.max(0, Date.now() - this.lastContextTimestamp);
		const elapsedText = formatCacheElapsed(elapsedMs);
		const remainingText = formatCacheRemaining(elapsedMs, this.ttlMs);
		return `Önbellek: ${elapsedText} / ${ttlText} geçti (${elapsedMs >= this.ttlMs ? "hatırlatma süresi doldu" : `kalan: ${remainingText}`}). ${note} ${soundText}.`;
	}

	public paintFor(theme?: Theme): CacheTimerPaint {
		if (this.cachedPaint !== null && this.cachedTheme === theme) return this.cachedPaint;

		const scheme = resolveThemeAppearance(theme);
		const palette = resolvePalette(scheme);
		const colorMode = resolveThemeColorMode(theme);
		const paint: CacheTimerPaint = {
			colorize: (text, c) => colorizeRgb(text, c, colorMode),
			ttlColor: theme && typeof theme.colors === "object" ? (text, ratio) => {
				const colors = theme.colors;
				const color = ratio <= 0.6
					? PiTui.mixColors(colors.success, colors.warning, ratio / 0.6, "srgb")
					: PiTui.mixColors(colors.warning, colors.error, (ratio - 0.6) / 0.4, "srgb");
				return PiTui.styleText(text, { fg: color }, colorMode);
			} : undefined,
			dim: (text) => themeText(theme, "dim", text, (value) => `\x1b[2m${value}\x1b[22m`),
			accent: (text) => themeText(theme, "accent", text, (value) => paletteFg(palette.cc.claude, value, colorMode)),
			red: (text) => themeText(theme, "error", text, (value) => paletteFg(palette.cc.error, value, colorMode)),
			scheme,
			colorMode,
		};

		this.cachedTheme = theme;
		this.cachedPaint = paint;
		return paint;
	}

	public startLoop(ctx: UiCtx): void {
		this.lastCtx = ctx;
		this.consecutiveWidgetErrors = 0;
		if (!ctx.hasUI) {
			this.stopLoop();
			return;
		}
		if (this.timer !== null) return;
		this.timer = setInterval(() => {
			if (this.lastCtx) this.repaint(this.lastCtx);
		}, 1000);
		this.timer.unref?.();
	}

	public stopLoop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	public repaint(ctx: UiCtx): void {
		this.lastCtx = ctx;
		if (!ctx.hasUI || !ctx.ui?.setWidget) return;

		const elapsedMs =
			this.lastContextTimestamp === null
				? 0
				: Math.max(0, Date.now() - this.lastContextTimestamp);

		// Sound milestones must fire even if widget rendering fails below:
		// a broken widget frame must never silence the audio warnings.
		try {
			if (ctx.model) {
				const observation = this.getCacheObservation(ctx);
				if (observation.timestamp !== undefined && observation.ttlMs) {
					const age = Math.max(0, Date.now() - observation.timestamp);
					if (age < observation.ttlMs) this.checkSoundMilestones(age, observation.ttlMs);
				}
			} else this.checkSoundMilestones(elapsedMs);
		} catch {
			/* best-effort sound notification */
		}

		try {
			if (this.footerRenderer) {
				this.footerRenderer();
				this.consecutiveWidgetErrors = 0;
				return;
			}
			const gitSummary = this.gitInfoProvider ? this.gitInfoProvider() : null;

			// If explicitly toggled off or (no context yet and no git summary), hide widget
			if (
				!this.isVisible ||
				(this.lastContextTimestamp === null && !this.isProcessing && !gitSummary)
			) {
				ctx.ui.setWidget("cache-timer", undefined, { placement: "belowEditor" });
				this.consecutiveWidgetErrors = 0;
				return;
			}

			const theme = ctx.ui.theme;
			const paint = this.paintFor(theme);
			const columns =
				process.stdout?.columns && process.stdout.columns > 0
					? process.stdout.columns
					: 80;

			const observation = ctx.model ? this.getCacheObservation(ctx) : undefined;
			const line = buildCacheTimerLine(
				{
					badgeText: observation ? (formatPromptCacheObservation(observation) || "cache ?") : undefined,
					elapsedMs,
					ttlMs: this.ttlMs,
					columns,
					hasContext: this.lastContextTimestamp !== null || this.isProcessing,
					isProcessing: this.isProcessing,
					gitSummary,
				},
				paint,
			);

			if (!line) {
				ctx.ui.setWidget("cache-timer", undefined, { placement: "belowEditor" });
				return;
			}

			ctx.ui.setWidget("cache-timer", [line], { placement: "belowEditor" });
			this.consecutiveWidgetErrors = 0;
		} catch {
			// Tolerate transient UI errors (teardown races): stop the loop only
			// after repeated consecutive failures. Every agent lifecycle event
			// restarts it via startLoop, so recovery is automatic.
			this.consecutiveWidgetErrors++;
			if (this.consecutiveWidgetErrors >= MAX_CONSECUTIVE_WIDGET_ERRORS) {
				this.stopLoop();
			}
		}
	}

	public handleSessionStart(
		ctx: UiCtx & { sessionManager?: SessionManagerLike },
	): void {
		this.lastCtx = ctx;
		this.isProcessing = false;

		this.promptCache.reset();
		this.observationCache = undefined;
		// Only provider assistant requests on the active branch are activity evidence.
		let foundTimestamp: number | null = null;
		if (ctx.sessionManager?.getEntries) {
			try {
				const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
				if (Array.isArray(entries)) {
					for (let i = entries.length - 1; i >= 0; i--) {
						const e = entries[i];
						if (e?.type === "compaction") break;
						if (e?.type === "message" && e.message?.role === "assistant") {
							const parsed = e.message.timestamp ?? Date.parse(e.timestamp ?? "");
							if (Number.isFinite(parsed) && parsed > 0 && parsed <= Date.now()) {
								foundTimestamp = parsed;
								break;
							}
						}
					}
				}
			} catch {
				/* best-effort session entry inspection */
			}
		}

		this.lastContextTimestamp = foundTimestamp;

		if (this.lastContextTimestamp === null) {
			this.resetMilestones();
			const gitSummary = this.gitInfoProvider ? this.gitInfoProvider() : null;
			if (gitSummary) {
				this.startLoop(ctx);
				this.repaint(ctx);
			} else {
				this.stopLoop();
				if (ctx.hasUI && ctx.ui?.setWidget) {
					try {
						ctx.ui.setWidget("cache-timer", undefined, { placement: "belowEditor" });
					} catch {
						/* best-effort */
					}
				}
			}
		} else {
			const initialElapsed = Math.max(0, Date.now() - this.lastContextTimestamp);
			this.seedMilestones(initialElapsed);
			this.startLoop(ctx);
			this.repaint(ctx);
		}
	}

	public handleAgentStart(ctx: UiCtx): void {
		this.lastCtx = ctx;
		this.isProcessing = true;
		this.startLoop(ctx);
		this.repaint(ctx);
	}

	public handleBeforeProviderRequest(ctx: UiCtx, payload?: unknown): void {
		this.lastCtx = ctx;
		this.promptCache.request(ctx.model, payload);
		this.lastContextTimestamp = Date.now();
		this.isProcessing = true;
		if (!ctx.model) this.resetMilestones();
		this.repaint(ctx);
	}

	public handleMessageEnd(event: MessageEndEvent, ctx: UiCtx): void {
		const previous = this.promptCache.observe(ctx.model).timestamp;
		this.promptCache.message(event.message);
		this.observationCache = undefined;
		const current = this.promptCache.observe(ctx.model).timestamp;
		if (current !== undefined && current !== previous) this.resetMilestones();
		this.lastCtx = ctx;
		this.repaint(ctx);
	}

	public handleTurnEnd(_event: TurnEndEvent, ctx: UiCtx): void {
		this.lastCtx = ctx;
	}

	public handleAgentSettled(ctx: UiCtx): void {
		this.promptCache.settled();
		this.lastCtx = ctx;
		this.isProcessing = false;
		this.startLoop(ctx);
		this.repaint(ctx);
	}

	public handleSessionShutdown(ctx?: UiCtx): void {
		this.stopLoop();
		this.promptCache.reset();
		this.observationCache = undefined;
		const targetCtx = ctx ?? this.lastCtx;
		this.lastCtx = null;
		this.footerRenderer = null;
		if (targetCtx?.hasUI && targetCtx.ui?.setWidget) {
			try {
				targetCtx.ui.setWidget("cache-timer", undefined, {
					placement: "belowEditor",
				});
			} catch {
				/* best-effort */
			}
		}
	}

	public dispose(): void {
		this.handleSessionShutdown();
	}
}

/**
 * Registers the Cache TTL counter extension.
 */
export function registerCacheTimer(
	pi: ExtensionAPI,
	options?: CacheTimerOptions,
): CacheTimerController {
	const controller = new CacheTimerController(options);

	pi.on("session_start", async (_event, ctx) => {
		controller.handleSessionStart(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		controller.handleAgentStart(ctx);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		controller.handleBeforeProviderRequest(ctx, event.payload);
	});

	pi.on("model_select", async (_event, ctx) => controller.handleSessionStart(ctx));
	pi.on("session_compact", async (_event, ctx) => controller.handleSessionStart(ctx));
	pi.on("session_tree", async (_event, ctx) => controller.handleSessionStart(ctx));

	pi.on("message_end", async (event, ctx) => {
		controller.handleMessageEnd(event, ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		controller.handleTurnEnd(event, ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		controller.handleAgentSettled(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		controller.handleSessionShutdown(ctx);
	});

	// Register /cache slash command for interactive queries & toggling
	pi.registerCommand("cache", {
		description:
			"Raporlanan cache kullanımı ve tahmini yaş bilgisi (/cache toggle, /cache sound, /cache sound test)",
		handler: async (args, ctx) => {
			const clean = sanitizeControlChars(stripAnsi(args)).trim().toLowerCase();
			if (clean === "toggle") {
				const visible = controller.toggleVisibility(ctx);
				notifySafely(ctx, `Önbellek sayacı: ${visible ? "açık" : "kapalı"}`, "info");
				return;
			}
			if (
				clean === "sound" ||
				clean === "ses" ||
				clean === "sound toggle" ||
				clean === "ses toggle"
			) {
				const enabled = controller.toggleSound();
				notifySafely(
					ctx,
					`Önbellek sesli uyarıları: ${enabled ? "açık" : "kapalı"}`,
					"info",
				);
				return;
			}
			if (clean === "sound on" || clean === "ses aç") {
				controller.setSoundEnabled(true);
				notifySafely(ctx, "Önbellek sesli uyarıları: açık", "info");
				return;
			}
			if (clean === "sound off" || clean === "ses kapat") {
				controller.setSoundEnabled(false);
				notifySafely(ctx, "Önbellek sesli uyarıları: kapalı", "info");
				return;
			}
			if (
				clean === "sound test" ||
				clean === "ses test" ||
				clean === "test sound"
			) {
				controller.playMilestoneSound("3.mp3", 1);
				notifySafely(
					ctx,
					"Ses testi: 3.mp3 çalınıyor. Ses gelmiyorsa oynatıcıyı (mpv/ffplay) ve ses çıkışını kontrol et.",
					"info",
				);
				return;
			}
			notifySafely(ctx, controller.getStatusSummary(), "info");
		},
	});

	return controller;
}
