/**
 * Recorded provider usage plus a local idle reminder, independent of provider TTL.
 * The reminder stays fresh during agent activity and restarts at settlement.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	Theme,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	resolvePalette,
	resolveThemeAppearance,
	resolveThemeColorMode,
	themeText,
	fg as paletteFg,
	sanitizeControlChars,
	stripAnsi,
} from "./palette.ts";
import { notifySafely } from "./pi-compat.ts";
import { PromptCacheTracker, type CacheEntry, type CacheModel, type PromptCacheObservation } from "./prompt-cache.ts";
import { playAudio, resolveSoundPath, type SoundPlayerFn } from "./audio.ts";
import {
	DEFAULT_CACHE_TTL_MS,
	buildCacheTimerLine,
	cacheTtlText,
	colorizeRgb,
	formatCacheElapsed,
	formatCacheRemaining,
	getCacheTtlRatio,
	type CacheTimerPaint,
} from "./cache-display.ts";

// Preserve module-level imports for standalone callers.
export { playAudio, resolveSoundPath, detectAudioPlayer, type SoundPlayerFn } from "./audio.ts";
export {
	DEFAULT_CACHE_TTL_MS, DARK_CACHE_STOPS, LIGHT_CACHE_STOPS,
	interpolateRgb, getCacheColor, rgbToAnsi, colorizeRgb,
	formatCacheElapsed, formatCacheRemaining, getCacheTtlRatio,
	buildCacheTimerLine, cacheTtlText, formatPromptCacheObservation,
	type ColorStop, type CacheTimerFrameState, type CacheTimerPaint,
} from "./cache-display.ts";

/** Change one tuple for every provider/window; ratios must increase strictly within (0, 1). */
export const DEFAULT_CACHE_SOUND_RATIOS: readonly [number, number, number] = [0.5, 0.8, 0.9];

// ---------------------------------------------------------------------------
// Audio notification milestones & playback helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Controller & Lifecycle Management
// ---------------------------------------------------------------------------

export type UiCtx = Pick<ExtensionContext, "hasUI" | "ui"> & {
	readonly model?: CacheModel;
	readonly sessionManager?: SessionManagerLike;
	readonly isIdle?: () => boolean;
};

export interface SessionManagerLike {
	getEntries?(): readonly CacheEntry[];
	getBranch?(): readonly CacheEntry[];
	getSessionId?(): string;
	getLeafId?(): string | null;
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
			this.lastContextTimestamp === null ||
			elapsedMs >= ttlMs
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
			this.lastContextTimestamp === null || this.isProcessing
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
		let evidence = "";
		if (this.lastCtx?.model) {
			const observation = this.getCacheObservation();
			const usage = observation.usage;
			const actual = observation.readPercent === undefined ? "Cache read: bilinmiyor."
				: `Son istek cache read: %${Math.round(observation.readPercent)} (${usage!.cacheRead} read, ${usage!.cacheWrite} write, ${usage!.input} uncached token).`;
			const warm = observation.warmUsage;
			const warmText = warm ? `Pi warm: ${warm.cacheRead} read, ${warm.cacheWrite} write token. ` : "";
			evidence = `${actual} ${warmText}`;
		}
		const soundText = this.isSoundEnabled
			? `Sesli uyarı: açık (${this.soundMilestoneRatios.map((ratio) => `%${Math.round(ratio * 100)}`).join(", ")})`
			: "Sesli uyarı: kapalı";
		const ttlText = formatCacheElapsed(this.ttlMs);
		const note = `${evidence}Bu yerel hatırlatıcı sağlayıcının cache durumunu göstermez.`;
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
			ttlColor: (text, ratio) => cacheTtlText(text, ratio, theme),
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
		// Manual compaction can finish without agent_settled. Observe both host
		// transitions so the reminder cannot stay stuck in processing afterward.
		if (ctx.isIdle) {
			const processing = !ctx.isIdle();
			if (this.isProcessing && !processing) {
				this.lastContextTimestamp = Date.now();
				this.resetMilestones();
			}
			this.isProcessing = processing;
		}
		if (!ctx.hasUI || !ctx.ui?.setWidget) return;

		const elapsedMs =
			this.lastContextTimestamp === null
				? 0
				: Math.max(0, Date.now() - this.lastContextTimestamp);

		// Sound milestones must fire even if widget rendering fails below:
		// a broken widget frame must never silence the audio warnings.
		try {
			this.checkSoundMilestones(elapsedMs);
		} catch {
			/* best-effort sound notification */
		}

		try {
			if (this.footerRenderer) {
				this.footerRenderer();
				return;
			}
			const gitSummary = this.gitInfoProvider ? this.gitInfoProvider() : null;

			// If explicitly toggled off or (no context yet and no git summary), hide widget
			if (
				!this.isVisible ||
				(this.lastContextTimestamp === null && !this.isProcessing && !gitSummary)
			) {
				ctx.ui.setWidget("cache-timer", undefined, { placement: "belowEditor" });
				return;
			}

			const theme = ctx.ui.theme;
			const paint = this.paintFor(theme);
			const columns =
				process.stdout?.columns && process.stdout.columns > 0
					? process.stdout.columns
					: 80;

			const line = buildCacheTimerLine(
				{
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
		} catch {
			// Presentation is best-effort. Keep the shared audio/refresh loop alive;
			// shutdown/disposal, not a failed frame, owns its lifetime.
		}
	}

	public handleSessionStart(
		ctx: UiCtx & { sessionManager?: SessionManagerLike },
	): void {
		this.lastCtx = ctx;
		this.isProcessing = ctx.isIdle ? !ctx.isIdle() : false;

		this.promptCache.reset();
		this.observationCache = undefined;
		// Only provider assistant requests on the active branch are activity evidence.
		let foundTimestamp: number | null = null;
		try {
			const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.();
			if (Array.isArray(entries)) {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
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

		this.lastContextTimestamp = foundTimestamp;
		this.seedMilestones(foundTimestamp === null ? 0 : Math.max(0, Date.now() - foundTimestamp));
		if (foundTimestamp !== null || this.isProcessing || this.gitInfoProvider?.()) this.startLoop(ctx);
		else this.stopLoop();
		this.repaint(ctx);
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
		this.resetMilestones();
		this.repaint(ctx);
	}

	public handleMessageEnd(event: MessageEndEvent, ctx: UiCtx): void {
		this.promptCache.message(event.message);
		this.observationCache = undefined;
		this.lastCtx = ctx;
		this.repaint(ctx);
	}

	public handleTurnEnd(_event: TurnEndEvent, ctx: UiCtx): void {
		this.lastCtx = ctx;
	}

	public handleAgentSettled(ctx: UiCtx): void {
		// A completed run needs no provider hook; duplicate settlements must not rearm sounds.
		if (this.isProcessing || this.lastContextTimestamp === null) {
			this.lastContextTimestamp = Date.now();
			this.resetMilestones();
		}
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

	// Model selection changes usage matching, not local activity or sound history.
	pi.on("model_select", async (_event, ctx) => controller.repaint(ctx));
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
			"Raporlanan cache kullanımı ve yerel hatırlatıcı (/cache toggle, /cache sound, /cache sound test)",
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
