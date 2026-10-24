/**
 * CC spinner status row, reproduced on pi's public APIs.
 *
 * Uses Pi's extension UI to draw a concise status line: an animated glyph,
 * action verb, and the available token/time details. It avoids extra shimmer
 * effects and repaints only when the glyph frame changes. UI calls are guarded
 * so teardown or a host API mismatch cannot take down the agent.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	MessageUpdateEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	fg as paletteFg,
	resolvePalette,
	resolveThemeAppearance,
	resolveThemeColorMode,
	themeText,
	visibleWidth,
	sanitizeControlChars,
	sanitizeTitle,
	stripAnsi,
} from "./palette.ts";

// CC Spinner/utils.ts getDefaultCharacters(): Ghostty renders ✽ slightly offset,
// so the last frame is * there.
function defaultCharacters(): readonly string[] {
	if (process.env.TERM === "xterm-ghostty")
		return ["·", "✢", "✳", "✶", "✻", "*"];
	return ["·", "✢", "✳", "✶", "✻", "✽"];
}

const FRAMES: readonly string[] = defaultCharacters();
// Forward then reverse — CC's SpinnerAnimationRow plays the loop ping-pong.
const SPINNER: readonly string[] = [...FRAMES, ...[...FRAMES].reverse()];
// CC SpinnerAnimationRow.tsx:133 — frame = Math.floor(time / 120).
const FRAME_MS = 120;
// Repaint once per glyph frame; avoid redundant UI updates between frames.
const TICK_MS = FRAME_MS;

// 5-bit Gray code: exactly one bit flips per tick, so the counter ripples smoothly
// instead of flickering, and the last frame differs from the first by one bit (seamless loop).
const BINARY_FRAMES: readonly string[] = Array.from({ length: 32 }, (_, i) =>
	(i ^ (i >> 1)).toString(2).padStart(5, "0"),
);

// A short morse phrase scrolls through a fixed six-cell window (every frame is 6 wide).
const MORSE_CYCLE = "·-··--·-···-";
const MORSE_FRAMES: readonly string[] = Array.from({ length: MORSE_CYCLE.length }, (_, i) =>
	(MORSE_CYCLE + MORSE_CYCLE).slice(i, i + 6),
);

// Braille dot bits per [column][row], rows top → bottom. Lets frames be drawn as pixels.
const BRAILLE_DOT: readonly (readonly number[])[] = [
	[0x01, 0x02, 0x04, 0x40],
	[0x08, 0x10, 0x20, 0x80],
];
const brailleChar = (bits: number): string => String.fromCharCode(0x2800 + bits);

// Two sine strands in opposite phase scroll one dot column per tick through a
// four-cell window (8 dot columns), so they cross like a double helix.
// The pattern repeats after half a period (the strands swap), hence length / 2 frames.
// Row at column c + half a period is the mirror (3 - row), which is the second strand.
const STRAND_ROWS: readonly number[] = [1, 0, 0, 0, 1, 2, 2, 3, 3, 3, 2, 1];
const DNA_FRAMES: readonly string[] = Array.from({ length: STRAND_ROWS.length / 2 }, (_, shift) =>
	Array.from({ length: 4 }, (_, cell) => {
		let bits = 0;
		for (let side = 0; side < 2; side++) {
			const col = shift + cell * 2 + side;
			const a = STRAND_ROWS[col % STRAND_ROWS.length]!;
			const b = STRAND_ROWS[(col + STRAND_ROWS.length / 2) % STRAND_ROWS.length]!;
			bits |= BRAILLE_DOT[side]![a]! | BRAILLE_DOT[side]![b]!;
		}
		return brailleChar(bits);
	}).join(""),
);

// One dot falls down each of four cells, staggered, then the cell rests for two ticks.
const RAIN_PHASES: readonly number[] = [0, 3, 1, 4];
const RAIN_PERIOD = 6;
const RAIN_FRAMES: readonly string[] = Array.from({ length: RAIN_PERIOD }, (_, tick) =>
	RAIN_PHASES.map((phase, cell) => {
		const row = (tick + phase) % RAIN_PERIOD;
		return row < 4 ? brailleChar(BRAILLE_DOT[cell % 2]![row]!) : " ";
	}).join(""),
);

const ANIMATIONS = {
	original: { frames: SPINNER, frameMs: TICK_MS },
	rotate: { frames: ["|", "/", "-", "\\"], frameMs: 240 },
	// A compact rotating trail: smooth motion without changing the glyph's footprint.
	orbit: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], frameMs: 100 },
	// Four-dot interlacing trails keep a steady visual weight as they cross.
	helix: { frames: ["⢎", "⢕", "⢣", "⢱", "⡱", "⡣", "⡕", "⡎"], frameMs: 140 },
	// A soft density wave; repeated extrema give the opening and closing room to breathe.
	ripple: { frames: ["⠒", "⠶", "⣶", "⣿", "⣿", "⠿", "⠶", "⠒", "⠒"], frameMs: 120 },
	// A contiguous four-dot arc sweeps the perimeter, including across the loop seam.
	comet: { frames: ["⠹", "⠛", "⠏", "⡇", "⣆", "⣤", "⣰", "⢸"], frameMs: 90 },
	// Two staggered pairs of dots scroll around the four braille rows.
	weave: { frames: ["⢣", "⢎", "⡜", "⡱"], frameMs: 160 },
	// Knight Rider scanner: a single lit cell sweeps a five-cell bar and back.
	scanner: {
		frames: ["▰▱▱▱▱", "▱▰▱▱▱", "▱▱▰▱▱", "▱▱▱▰▱", "▱▱▱▱▰", "▱▱▱▰▱", "▱▱▰▱▱", "▱▰▱▱▱"],
		frameMs: 90,
	},
	// A transmitter dot sends out arcs that grow and fade back, like a broadcast.
	signal: { frames: ["·   ", "·)  ", "·)) ", "·)))", "·)) ", "·)  "], frameMs: 130 },
	// A five-bit Gray-code counter: one digit flips at a time, like a bit scanning across.
	binary: { frames: BINARY_FRAMES, frameMs: 70 },
	// A thin box-drawing stroke pivots around the cell like a turning key.
	pivot: { frames: ["┤", "┘", "┴", "└", "├", "┌", "┬", "┐"], frameMs: 110 },
	// Calculus and ML notation (gradient, integral, sum…) cycling in place.
	calculus: { frames: ["∂", "∇", "∫", "∑", "∏", "∞"], frameMs: 200 },
	// A small face that holds still, then blinks.
	blink: {
		frames: ["(•_•)", "(•_•)", "(•_•)", "(•_•)", "(-_-)", "(•_•)", "(•_•)", "(•_•)"],
		frameMs: 160,
	},
	// Chat-style typing indicator: three dots rise and fall in a rolling wave.
	typing: { frames: [".·˙", "·˙·", "˙·.", "·.·"], frameMs: 150 },
	// Three stars twinkle out of phase: dim → bright → dim.
	twinkle: { frames: ["· ✧ ✦", "✧ ✦ ✧", "✦ ✧ ·", "✧ · ✧"], frameMs: 180 },
	// A dot grows inside brackets, like a lens locking focus.
	focus: { frames: ["[   ]", "[ · ]", "[ • ]", "[ ● ]", "[ • ]", "[ · ]"], frameMs: 140 },
	// A morse phrase scrolls through a six-cell window.
	morse: { frames: MORSE_FRAMES, frameMs: 130 },
	// A double helix scrolls by: two braille strands crossing every few dots.
	dna: { frames: DNA_FRAMES, frameMs: 110 },
	// Dots fall through four braille cells at staggered times, like light rain.
	rain: { frames: RAIN_FRAMES, frameMs: 120 },
	// Newton's cradle: the end ball swings out, the impact passes through, the other end answers.
	cradle: {
		frames: ["● ●●● ", "● ●●● ", " ●●●● ", " ●●● ●", " ●●● ●", " ●●●● "],
		frameMs: 130,
	},
} as const;

type SpinnerAnimation = keyof typeof ANIMATIONS;
const ANIMATION_NAMES = Object.keys(ANIMATIONS) as SpinnerAnimation[];
// Leave each animation time to settle; switch only after a whole number of loops.
const ANIMATION_DWELL_MS = 8000;

// AI / teknoloji / bilim / mistik karışımı, tek kelimelik edilgen fiiller (200 adet)
const VERBS = [
	// Makine öğrenmesi
	"Nöronlanıyor",
	"Kuantlanıyor",
	"Vektörleniyor",
	"Tensörleniyor",
	"Matrisleniyor",
	"Eğimleniyor",
	"Ezberleniyor",
	"Halüsinleniyor",
	"Mantıklanıyor",
	"Eğitiliyor",
	"Damıtılıyor",
	"Budanıyor",
	"Gömülüyor",
	"Nicemleniyor",
	"Pekiştiriliyor",
	"Terbiyeleniyor",
	"Sinirleniyor",
	"Zincirleniyor",
	"Maskeleniyor",
	"Örnekleniyor",
	"Eşikleniyor",
	"Soğutuluyor",
	"Sönümleniyor",
	"Seyreltiliyor",
	"Donduruluyor",
	"Çıkarsanıyor",
	"Kestiriliyor",
	"Bağlamlanıyor",
	"Çaprazlanıyor",
	"Yakınsatılıyor",

	// Dil, şüphe ve duygu
	"Papağanlanıyor",
	"Geveleniyor",
	"Zırvalanıyor",
	"Mırıldanılıyor",
	"Fısıldanıyor",
	"Yankılanıyor",
	"Kandırılıyor",
	"Yanıltılıyor",
	"Şaşırtılıyor",
	"Kuşkulanıyor",
	"Tereddütleniyor",
	"Endişeleniyor",
	"Meraklanıyor",
	"Heyecanlanıyor",
	"Şüpheleniyor",
	"Kaygılanıyor",
	"Sabırsızlanıyor",
	"Akıllanıyor",
	"Tartışılıyor",
	"Danışılıyor",
	"Unutuluyor",
	"Anımsanıyor",
	"Sezinleniyor",
	"Düşleniyor",
	"İmgeleniyor",
	"Esinleniyor",
	"Özümseniyor",
	"Benimseniyor",
	"Kavranıyor",
	"Aydınlanıyor",

	// Kuantum ve fizik
	"Işınlanıyor",
	"Çöktürülüyor",
	"Dolaştırılıyor",
	"Çakıştırılıyor",
	"Tünelleniyor",
	"Soğuruluyor",
	"Yansıtılıyor",
	"Kırılıyor",
	"Dalgalanıyor",
	"Salınıyor",
	"Evriliyor",
	"Titreştiriliyor",
	"Kutuplanıyor",
	"Mıknatıslanıyor",
	"Sıkıştırılıyor",
	"Genleştiriliyor",
	"Buharlaştırılıyor",
	"Yoğunlaştırılıyor",
	"Kristalleniyor",
	"Eritiliyor",
	"Kaynatılıyor",
	"Damlatılıyor",
	"Ayrıştırılıyor",
	"Kırpılıyor",
	"Biçiliyor",
	"Doğranıyor",
	"Dilimleniyor",
	"Öğütülüyor",
	"Eleniyor",
	"Süzülüyor",

	// Mutfak ve zanaat (absürt kısım)
	"Pişiriliyor",
	"Zımparalanıyor",
	"Mayalanıyor",
	"Demleniyor",
	"Kavruluyor",
	"Yoğruluyor",
	"Tütsüleniyor",
	"Cilalanıyor",
	"Perdahlanıyor",
	"Törpüleniyor",
	"Kazınıyor",
	"Kurcalanıyor",
	"Eşeleniyor",
	"Karıştırılıyor",
	"Deşiliyor",
	"Dürtükleniyor",
	"Çiğneniyor",
	"Sindiriliyor",
	"Yutuluyor",
	"Emiliyor",
	"Savruluyor",
	"Harmanlanıyor",
	"Kaynaştırılıyor",
	"Lehimleniyor",
	"Perçinleniyor",
	"Mühürleniyor",
	"Örülüyor",
	"Düğümleniyor",
	"Ilmekleniyor",
	"Nakışlanıyor",

	// Yazılım ve sistem
	"Derleniyor",
	"Kodlanıyor",
	"Çözümleniyor",
	"Açımlanıyor",
	"Şifreleniyor",
	"Çözülüyor",
	"Yedekleniyor",
	"Eşitleniyor",
	"Eşzamanlanıyor",
	"Köprüleniyor",
	"Yönlendiriliyor",
	"Yamanıyor",
	"Çatallanıyor",
	"Ayıklanıyor",
	"Onarılıyor",
	"Arındırılıyor",
	"Hortlatılıyor",
	"Diriltiliyor",
	"Sonlandırılıyor",
	"Uyutuluyor",
	"Uyandırılıyor",
	"Hızlandırılıyor",
	"Frenleniyor",
	"Tetikleniyor",
	"Gizleniyor",
	"Kilitleniyor",
	"Döngüleniyor",
	"Yineleniyor",
	"Sızdırılıyor",
	"Taşırılıyor",
	"Sıfırlanıyor",
	"Hizalanıyor",
	"Kıyaslanıyor",
	"Puanlanıyor",
	"Önyükleniyor",
	"Önbellekleniyor",
	"Çekirdekleniyor",
	"Katmanlanıyor",
	"Çizgeleniyor",
	"Dizinleniyor",

	// Mistik ve dönüşüm
	"Simyalanıyor",
	"Tılsımlanıyor",
	"Efsunlanıyor",
	"Büyüleniyor",
	"Sihirleniyor",
	"Gizemleniyor",
	"Ruhlandırılıyor",
	"Canlandırılıyor",
	"Bilinçleniyor",
	"Çağrılıyor",
	"Tohumlanıyor",
	"Filizleniyor",
	"Kıvılcımlanıyor",
	"Alevlendiriliyor",
	"Tutuşturuluyor",
	"Yontuluyor",
	"Haritalanıyor",
	"Etiketleniyor",
	"Bölütleniyor",
	"Öbekleniyor",
	"Kümeleniyor",
	"Yığınlanıyor",
	"Kuyruklanıyor",
	"Paralelleniyor",
	"Dağıtılıyor",
	"Toparlanıyor",
	"Dengeleniyor",
	"Uyumlanıyor",
	"Sabitleniyor",
	"Gevşetiliyor",
	"Esnetiliyor",
	"Gerdiriliyor",
	"Bükülüyor",
	"Sarmalanıyor",
	"Soyutlanıyor",
	"Çerçeveleniyor",
	"Zamanlanıyor",
	"Sürümleniyor",
	"Ağırlıklanıyor",
	"Entropileniyor",
] as const;

export function sampleVerb(): string {
	return VERBS[Math.floor(Math.random() * VERBS.length)] ?? "İşleniyor";
}

let activeWorkingVerb: string = sampleVerb();

/** The active turn's spinner verb (for other modules restoring the working message). */
export function currentWorkingVerb(): string {
	return activeWorkingVerb;
}

// ---------------------------------------------------------------------------
// Pure frame builder (tested in isolation)
// ---------------------------------------------------------------------------

/** Color functions for one frame — resolved from the *live* theme each tick. */
export interface SpinnerPaint {
	/** Active theme's accent, with a standalone fallback. */
	readonly accent: (s: string) => string;
	/** Accent painter retained for callers using the shimmer interface. */
	readonly shimmer: (s: string) => string;
	/** CC's dimColor. */
	readonly dim: (s: string) => string;
	/** Optional theme/scheme-aware thinking glow function. */
	readonly thinking?: (s: string, timeMs: number) => string;
}

/** CC Spinner.tsx:125 — "thinking" while a block is open, then the finished
 *  block's duration in ms (shown as `thought for Ns` for 2s), then null. */
export type ThinkingStatus = "thinking" | number | null;

export interface SpinnerFrameState {
	/** Omitted for standalone callers to retain the original animation. */
	readonly animation?: SpinnerAnimation;
	/** Local glyph clock, independent of the request's elapsed time. */
	readonly animationTimeMs?: number;
	readonly verb: string;
	/** Milliseconds since the request (agent loop) started. */
	readonly timeMs: number;
	readonly columns: number;
	/** Cumulative downstream (output) tokens this request; segment hidden when 0/undefined. */
	readonly tokens?: number;
	/** Tokens generated per second (live streaming rate or final message rate). */
	readonly tokensPerSecond?: number | null;
	/** CC thinkingStatus (Spinner.tsx:125). */
	readonly thinkingStatus?: ThinkingStatus;
	/** CC getEffortSuffix (effort.ts:188): ` with high effort`, "" when unset. */
	readonly effortSuffix?: string;
	/** How long the current thinking block has been open — drives the
	 *  "almost done thinking" wording on long thinks. */
	readonly thinkingElapsedMs?: number;
}

/** CC-style compact token count: 847 → "847", 1234 → "1.2k", 25600 → "26k", 1500000 -> "1.5M". */
export function formatTokenCount(n: number): string {
	const safe =
		typeof n === "number" && Number.isFinite(n) && !Number.isNaN(n) && n >= 0
			? Math.floor(n)
			: 0;
	if (safe < 1000) return String(safe);
	if (safe < 10_000) {
		const thousands = Math.floor(safe / 1000);
		const tenths = Math.round((safe % 1000) / 100);
		if (tenths === 0) return `${thousands}k`;
		if (tenths === 10) return `${thousands + 1}k`;
		return `${thousands}.${tenths}k`;
	}
	if (safe < 1_000_000) return `${Math.round(safe / 1000)}k`;
	const millions = Math.floor(safe / 1_000_000);
	const tenths = Math.round((safe % 1_000_000) / 100_000);
	if (tenths === 0) return `${millions}M`;
	if (tenths === 10) return `${millions + 1}M`;
	return `${millions}.${tenths}M`;
}

/** Elapsed time for the spinner byline: 12sn / 1dk 5sn / 1sa 2dk 3sn. */
export function formatElapsed(ms: number): string {
	const safe =
		typeof ms === "number" && Number.isFinite(ms) && !Number.isNaN(ms) && ms >= 0
			? Math.floor(ms)
			: 0;
	const total = Math.floor(safe / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}sa ${m}dk ${s}sn`;
	if (m > 0) return `${m}dk ${s}sn`;
	return `${s}sn`;
}

/**
 * Optional shimmer helper retained for callers that want the original effect;
 * the default spinner row now uses a steady accent color.
 */
export function glimmerMessage(
	message: string,
	glimmerIndex: number,
	paint: SpinnerPaint,
): string {
	if (!message || typeof message !== "string") return "";
	if (!Number.isFinite(glimmerIndex) || Number.isNaN(glimmerIndex))
		return paint.accent(message);

	const shimmerStart = glimmerIndex - 1;
	const shimmerEnd = glimmerIndex + 1;
	if (shimmerEnd < 0) return paint.accent(message);

	// Fast path for strings without astral/surrogate characters (standard BMP including Turkish & punctuation)
	let hasSurrogates = false;
	for (let i = 0; i < message.length; i++) {
		const code = message.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			hasSurrogates = true;
			break;
		}
	}

	if (!hasSurrogates) {
		const len = message.length;
		if (shimmerStart >= len) return paint.accent(message);
		const start = Math.max(0, shimmerStart);
		const end = Math.min(len - 1, shimmerEnd);
		const before = start > 0 ? message.slice(0, start) : "";
		const shim = message.slice(start, end + 1);
		const after = end + 1 < len ? message.slice(end + 1) : "";
		return (
			(before ? paint.accent(before) : "") +
			(shim ? paint.shimmer(shim) : "") +
			(after ? paint.accent(after) : "")
		);
	}

	const chars = Array.from(message);
	const messageWidth = chars.length;
	if (shimmerStart >= messageWidth) return paint.accent(message);

	const start = Math.max(0, shimmerStart);
	const end = Math.min(messageWidth - 1, shimmerEnd);
	const before = start > 0 ? chars.slice(0, start).join("") : "";
	const shim = chars.slice(start, end + 1).join("");
	const after = end + 1 < messageWidth ? chars.slice(end + 1).join("") : "";

	return (
		(before ? paint.accent(before) : "") +
		(shim ? paint.shimmer(shim) : "") +
		(after ? paint.accent(after) : "")
	);
}

// CC SpinnerAnimationRow.tsx:24-35 — the in-progress thinking segment breathes
// between two fixed grays (theme-independent in CC as well): 3s delay, then a
// 2s sine period. The past-tense `thought for Ns` renders plain dim.
const THINKING_INACTIVE_GRAY = 153;
const THINKING_SHIMMER_GRAY = 185;
const THINKING_DELAY_MS = 3000;
const THINKING_GLOW_PERIOD_S = 2;

// Precomputed truecolor gray escapes (0-255)
const RGB_GRAY_ANSI: readonly string[] = Array.from(
	{ length: 256 },
	(_, v) => `\x1b[38;2;${v};${v};${v}m`,
);

export function thinkingGlowPaint(
	timeMs: number,
	scheme: "dark" | "light" = "dark",
): (s: string) => string {
	const safeMs = Math.max(0, Number.isFinite(timeMs) ? timeMs : 0);
	const opacity =
		safeMs < THINKING_DELAY_MS
			? 0
			: (Math.sin(
					(((safeMs - THINKING_DELAY_MS) / 1000) * (Math.PI * 2)) /
						THINKING_GLOW_PERIOD_S,
				) +
					1) /
				2;
	let v: number;
	if (scheme === "light") {
		v = Math.round(105 - (105 - 65) * opacity);
	} else {
		v = Math.round(
			THINKING_INACTIVE_GRAY +
				(THINKING_SHIMMER_GRAY - THINKING_INACTIVE_GRAY) * opacity,
		);
	}
	const ansiPrefix = RGB_GRAY_ANSI[v] ?? `\x1b[38;2;${v};${v};${v}m`;
	return (s) => `${ansiPrefix}${s}\x1b[39m`;
}

/**
 * In-progress thinking wording. CC v2.1.234 escalates the copy as one thinking
 * block keeps running: `thinking` → `thinking more` → `thinking some more` →
 * `almost done thinking` (user-observed; the local CC snapshot predates this,
 * so the thresholds are a best-guess time ladder — CC likely keys off the
 * thinking-token budget, which pi does not expose).
 */
export function thinkingWording(blockElapsedMs: number): string {
	const safe =
		typeof blockElapsedMs === "number" && Number.isFinite(blockElapsedMs)
			? Math.max(0, blockElapsedMs)
			: 0;
	if (safe >= 120_000) return "düşünme tamamlanmak üzere";
	if (safe >= 60_000) return "biraz daha düşünülüyor";
	if (safe >= 30_000) return "derinlemesine düşünülüyor";
	return "düşünülüyor";
}

/**
 * Build one spinner line: `<glyph> <verb…> (12s · ↓ 1.2k tokens · thinking
 * with high effort)`. Pure — takes the animation clock and color functions,
 * returns an ANSI string. Mirrors SpinnerAnimationRow's derivations for a
 * single (non-teammate) agent. Glyph and verb are painted in the accent
 * (claude brand) color every tick — no gray verb (AUDIT §6), no baked-in frame
 * color with a steady accent verb and a simple dim byline.
 *
 * Width gating progressively degrades:
 * Full: [Glyph] [Verb] (Timer · Tokens · Thinking)
 * Medium: [Glyph] [Verb] (Timer · Thinking) or (Timer · Tokens)
 * Narrow: [Glyph] [Verb] (Timer) or (Thinking)
 * Compact: [Glyph] [Verb]
 * Ultra-narrow: [Glyph] [Truncated verb]… (never exceeds columns or breaks line wrap).
 */
export function buildSpinnerLine(
	state: SpinnerFrameState,
	paint: SpinnerPaint,
): string {
	let cleanVerb = typeof state?.verb === "string" ? state.verb : "";
	if (cleanVerb) {
		if (
			cleanVerb.includes("\x1b") ||
			cleanVerb.includes("\x9b") ||
			cleanVerb.includes("\x9d") ||
			cleanVerb.includes("\x90")
		) {
			cleanVerb = stripAnsi(cleanVerb);
		}
		// Fast check for control characters
		let hasControl = false;
		for (let i = 0; i < cleanVerb.length; i++) {
			const code = cleanVerb.charCodeAt(i);
			if (code < 32 || (code >= 127 && code <= 159)) {
				hasControl = true;
				break;
			}
		}
		if (hasControl) {
			cleanVerb = sanitizeControlChars(cleanVerb);
		}
		cleanVerb = cleanVerb.trim();
	}
	const rawVerb = cleanVerb || "İşleniyor";
	const timeMs =
		typeof state?.timeMs === "number" &&
		Number.isFinite(state.timeMs) &&
		state.timeMs >= 0
			? Math.floor(state.timeMs)
			: 0;
	const animation = ANIMATIONS[state?.animation ?? "original"] ?? ANIMATIONS.original;
	const animationTimeMs =
		typeof state?.animationTimeMs === "number" &&
		Number.isFinite(state.animationTimeMs) && state.animationTimeMs >= 0
			? state.animationTimeMs
			: timeMs;
	const frame = Math.floor(animationTimeMs / animation.frameMs) % animation.frames.length;
	const message = `${rawVerb}…`;
	const messageWidth = visibleWidth(message);

	const rawCols =
		typeof state?.columns === "number" && Number.isFinite(state.columns)
			? state.columns
			: 80;
	const cols = Math.max(0, Math.floor(rawCols));

	// Some animations are several cells wide. Measure the frame instead of assuming one cell,
	// and collapse to a single-cell glyph when the terminal is too narrow to fit it.
	let frameText: string = animation.frames[frame] ?? "✻";
	let glyphWidth = Math.max(1, visibleWidth(frameText));
	if (cols > 0 && glyphWidth > 1 && cols < glyphWidth + 4) {
		frameText = "·";
		glyphWidth = 1;
	}
	const glyph = paint.accent(frameText);

	// Progressive ultra-narrow viewport collapsing for constrained positive columns
	if (cols === 1) return glyph;
	if (cols === 2) return `${glyph} `;
	if (cols === 3) return `${glyph} …`;

	// Ultra-narrow: truncate verb stem to avoid terminal line wrapping when cols is bounded
	if (cols > 0 && cols < glyphWidth + 1 + messageWidth) {
		const maxStemWidth = cols - (glyphWidth + 2);
		const chars = Array.from(rawVerb);
		const truncatedStem = chars.slice(0, Math.max(1, maxStemWidth)).join("");
		const truncatedMessage = `${truncatedStem}…`;
		return `${glyph} ${paint.accent(truncatedMessage)}`;
	}

	const verbSpan = paint.accent(message);
	const availableSpace = cols > 0 ? cols - (glyphWidth + 1 + messageWidth) : -1;

	// Space below 4 cannot fit any byline (` (x)` requires min 4 columns)
	if (availableSpace < 4) {
		return `${glyph} ${verbSpan}`;
	}

	// --- Byline (CC SpinnerAnimationRow.tsx:163-215) -----------------------
	const status = state?.thinkingStatus ?? null;
	let effortSuffix =
		typeof state?.effortSuffix === "string" ? state.effortSuffix : "";
	if (
		effortSuffix &&
		(effortSuffix.includes("\x1b") || effortSuffix.includes("\x9b"))
	) {
		effortSuffix = sanitizeControlChars(stripAnsi(effortSuffix));
	}
	const rawThinkingElapsed =
		typeof state?.thinkingElapsedMs === "number" &&
		Number.isFinite(state.thinkingElapsedMs) &&
		state.thinkingElapsedMs >= 0
			? Math.floor(state.thinkingElapsedMs)
			: 0;
	const thinkingElapsedMs = Math.max(0, rawThinkingElapsed);

	let thinkingFull: string | null = null;
	let thinkingShort: string | null = null;
	if (status === "thinking") {
		const wording = thinkingWording(thinkingElapsedMs);
		thinkingFull = `${wording}${effortSuffix}`;
		thinkingShort = effortSuffix ? wording : null;
	} else if (
		typeof status === "number" &&
		Number.isFinite(status) &&
		status >= 0
	) {
		thinkingFull = `${Math.max(1, Math.round(status / 1000))}sn düşünüldü`;
	}

	const timerText = formatElapsed(timeMs);
	const rawTokens =
		typeof state?.tokens === "number" &&
		Number.isFinite(state.tokens) &&
		state.tokens > 0
			? Math.floor(state.tokens)
			: 0;
	const tokensText =
		rawTokens > 0 ? `↓ ${formatTokenCount(rawTokens)} token` : null;

	const rawTps =
		typeof state?.tokensPerSecond === "number" &&
		Number.isFinite(state.tokensPerSecond) &&
		state.tokensPerSecond > 0
			? Math.round(state.tokensPerSecond)
			: 0;
	const tpsText = rawTps > 0 ? `${rawTps} tok/s` : null;

	type Segment = readonly [text: string | null, width: number];
	const timer: Segment = [timerText, visibleWidth(timerText)];
	const tokens: Segment = [tokensText, tokensText ? visibleWidth(tokensText) : 0];
	const rate: Segment = [tpsText, tpsText ? visibleWidth(tpsText) : 0];
	const full: Segment = [thinkingFull, thinkingFull ? visibleWidth(thinkingFull) : 0];
	const short: Segment = [thinkingShort, thinkingShort ? visibleWidth(thinkingShort) : 0];
	const thinkingPaint = paint.dim;

	// First fitting candidate wins. Missing segments invalidate a candidate;
	// dropping them would change the established degradation priority.
	const candidates: readonly Segment[][] = [
		[timer, tokens, rate, full],
		[timer, tokens, rate, short],
		[timer, tokens, full],
		[timer, tokens, short],
		...(!thinkingFull ? [[timer, tokens, rate], [timer, tokens]] : []),
		[timer, full],
		[timer, short],
		[tokens, rate, full],
		[tokens, rate, short],
		[tokens, full],
		[tokens, short],
		[full],
		[short],
		[timer],
		[tokens, rate],
		[tokens],
	];
	for (const candidate of candidates) {
		if (candidate.some(([text]) => !text)) continue;
		// Leading space + parentheses, plus a three-column separator per gap.
		const width = candidate.reduce((sum, [, width]) => sum + width, candidate.length * 3);
		if (width > availableSpace) continue;

		// A lone active thinking status paints its parentheses in one span.
		if (candidate.length === 1 && status === "thinking" &&
			(candidate[0] === full || candidate[0] === short)) {
			return `${glyph} ${verbSpan} ${thinkingPaint(`(${candidate[0][0]})`)}`;
		}
		let byline = paint.dim("(");
		for (const [index, segment] of candidate.entries()) {
			if (index > 0) byline += paint.dim(" · ");
			const text = segment[0]!;
			byline += segment === full || segment === short
				? thinkingPaint(text)
				: paint.dim(text);
		}
		return `${glyph} ${verbSpan} ${byline}${paint.dim(")")}`;
	}

	return `${glyph} ${verbSpan}`;
}

// ---------------------------------------------------------------------------
// Registration + the frame-aligned repaint loop
// ---------------------------------------------------------------------------

/** CC getEffortSuffix (effort.ts:188-196): ` with ${level} effort`, "" when no
 *  effort applies. pi always has a thinking level; off/none map to "". */
export function effortSuffixFor(level: string | undefined): string {
	if (typeof level !== "string" || !level) return "";
	const sanitized = sanitizeControlChars(stripAnsi(level)).trim();
	if (!sanitized) return "";
	switch (sanitized) {
		case "none":
		case "off":
			return "";
		case "high":
			return " (yüksek eforla)";
		case "medium":
			return " (orta eforla)";
		case "low":
			return " (düşük eforla)";
		case "minimal":
			return " (minimum eforla)";
		case "xhigh":
		case "max":
			return " (maksimum eforla)";
		default:
			return ` (${sanitized} eforla)`;
	}
}

export type UiCtx = Pick<ExtensionContext, "hasUI" | "ui">;

export interface SpinnerStateSnapshot {
	readonly verb: string;
	readonly animStartMs: number;
	readonly settledTokens: number;
	readonly streamTokens: number;
	readonly totalTokens: number;
	readonly tokensPerSecond: number | null;
	readonly thinkingStatus: ThinkingStatus;
	readonly thinkingStartMs: number | null;
	readonly effortSuffix: string;
	readonly isActive: boolean;
	readonly hasActiveTimers: boolean;
}

export class SpinnerController {
	private animStartMs = 0;
	private animation: SpinnerAnimation = "original";
	private hasSelectedAnimation = false;
	private animationStartedMs = 0;
	private animationSwitchMs = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private settledTokens = 0;
	private streamTokens = 0;
	private thinkingStatus: ThinkingStatus = null;
	private thinkingStartMs: number | null = null;
	private effortSuffix = "";
	private thinkingShowTimer: ReturnType<typeof setTimeout> | null = null;
	private thinkingClearTimer: ReturnType<typeof setTimeout> | null = null;
	private repaintTimer: ReturnType<typeof setTimeout> | null = null;
	private verb: string = sampleVerb();
	private cachedTheme: Theme | undefined;
	private cachedPaint: SpinnerPaint | null = null;

	// Live streaming token rate tracking
	private contentStreamStart: number | null = null;
	private lastContentDeltaAt: number | null = null;
	private contentCharacters = 0;
	private firstContentDeltaCharacters = 0;
	private firstReportedTokens: number | null = null;
	private reportedStreamStart: number | null = null;
	private lastReportedDeltaAt: number | null = null;
	private runContentTokens = 0;
	private runContentStreamMs = 0;
	private currentTps: number | null = null;

	constructor() {
		activeWorkingVerb = this.verb;
	}

	public getVerb(): string {
		return this.verb;
	}

	public setVerb(v: string): void {
		const clean =
			typeof v === "string" ? sanitizeControlChars(stripAnsi(v)).trim() : "";
		this.verb = clean || "İşleniyor";
		activeWorkingVerb = this.verb;
	}

	public getTokensPerSecond(): number | null {
		return this.currentTps;
	}

	public setTokensPerSecond(tps: number | null): void {
		this.currentTps =
			typeof tps === "number" && Number.isFinite(tps) && tps > 0 ? tps : null;
	}

	public getState(): SpinnerStateSnapshot {
		return {
			verb: this.verb,
			animStartMs: this.animStartMs,
			settledTokens: this.settledTokens,
			streamTokens: this.streamTokens,
			totalTokens: this.settledTokens + this.streamTokens,
			tokensPerSecond: this.currentTps,
			thinkingStatus: this.thinkingStatus,
			thinkingStartMs: this.thinkingStartMs,
			effortSuffix: this.effortSuffix,
			isActive: this.timer !== null,
			hasActiveTimers: this.hasActiveTimers(),
		};
	}

	public hasActiveTimers(): boolean {
		return (
			this.timer !== null ||
			this.thinkingShowTimer !== null ||
			this.thinkingClearTimer !== null ||
			this.repaintTimer !== null
		);
	}

	public clearThinkingTimers(): void {
		if (this.thinkingShowTimer !== null) {
			clearTimeout(this.thinkingShowTimer);
			this.thinkingShowTimer = null;
		}
		if (this.thinkingClearTimer !== null) {
			clearTimeout(this.thinkingClearTimer);
			this.thinkingClearTimer = null;
		}
	}

	public clearRepaintTimer(): void {
		if (this.repaintTimer !== null) {
			clearTimeout(this.repaintTimer);
			this.repaintTimer = null;
		}
	}

	public stopLoop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.clearRepaintTimer();
		this.clearThinkingTimers();
	}

	public beginThinking(): void {
		if (this.thinkingStartMs !== null) return;
		this.clearThinkingTimers();
		this.thinkingStartMs = Date.now();
		this.thinkingStatus = "thinking";
	}

	public settleThinking(): void {
		if (this.thinkingStartMs === null) return;
		const duration = Math.max(0, Date.now() - this.thinkingStartMs);
		this.thinkingStartMs = null;

		const showDuration = (): void => {
			this.thinkingShowTimer = null;
			if (this.timer === null) {
				this.thinkingStatus = null;
				return;
			}
			this.thinkingStatus = duration;
			this.thinkingClearTimer = setTimeout(() => {
				this.thinkingClearTimer = null;
				this.thinkingStatus = null;
			}, 2000);
			this.thinkingClearTimer.unref?.();
		};

		const remaining = Math.max(0, 2000 - duration);
		if (remaining > 0) {
			this.thinkingShowTimer = setTimeout(showDuration, remaining);
			this.thinkingShowTimer.unref?.();
		} else {
			showDuration();
		}
	}

	public paintFor(theme?: Theme): SpinnerPaint {
		if (this.cachedPaint !== null && this.cachedTheme === theme) return this.cachedPaint;

		const scheme = resolveThemeAppearance(theme);
		const pal = resolvePalette(scheme);
		const colorMode = resolveThemeColorMode(theme);
		const paint: SpinnerPaint = {
			accent: (s) => themeText(theme, "accent", s, (text) => paletteFg(pal.cc.claude, text, colorMode)),
			shimmer: (s) => themeText(theme, "accent", s, (text) => paletteFg(pal.cc.claudeShimmer, text, colorMode)),
			dim: (s) => themeText(theme, "dim", s, (text) => `\x1b[2m${text}\x1b[22m`),
			thinking: (s, timeMs) => themeText(theme, "thinkingText", s, thinkingGlowPaint(timeMs, scheme)),
		};

		this.cachedTheme = theme;
		this.cachedPaint = paint;
		return paint;
	}

	private selectAnimation(now: number): void {
		const candidates = this.hasSelectedAnimation
			? ANIMATION_NAMES.filter((name) => name !== this.animation)
			: ANIMATION_NAMES;
		this.animation = candidates[Math.floor(Math.random() * candidates.length)] ?? "original";
		this.hasSelectedAnimation = true;
		this.animationStartedMs = now;
		const { frames, frameMs } = ANIMATIONS[this.animation];
		const cycleMs = frames.length * frameMs;
		this.animationSwitchMs = now + Math.ceil(ANIMATION_DWELL_MS / cycleMs) * cycleMs;
	}

	private restartAnimationLoop(ctx: UiCtx): void {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = setInterval(() => this.repaint(ctx), ANIMATIONS[this.animation].frameMs);
		this.timer.unref?.();
	}

	public repaint(ctx: UiCtx): void {
		if (!ctx.hasUI || this.timer === null) return;
		try {
			const now = Date.now();
			if (now >= this.animationSwitchMs) {
				this.selectAnimation(now);
				// Replace only the glyph interval, preserving pending thinking/rate updates.
				this.restartAnimationLoop(ctx);
			}
			const theme = ctx.ui?.theme;
			const line = buildSpinnerLine(
				{
					verb: this.verb,
					animation: this.animation,
					animationTimeMs: Math.max(0, now - this.animationStartedMs),
					timeMs: Math.max(0, now - this.animStartMs),
					columns:
						process.stdout?.columns && process.stdout.columns > 0
							? process.stdout.columns
							: 80,
					tokens: Math.max(0, this.settledTokens + this.streamTokens),
					tokensPerSecond: this.currentTps,
					thinkingStatus: this.thinkingStatus,
					effortSuffix: this.effortSuffix,
					thinkingElapsedMs:
						this.thinkingStartMs === null
							? 0
							: Math.max(0, Date.now() - this.thinkingStartMs),
				},
				this.paintFor(theme),
			);
			ctx.ui.setWorkingMessage(line);
		} catch {
			// UI torn down, stream closed, or stdout unavailable — stop loop immediately
			this.stopLoop();
		}
	}

	public scheduleRepaint(ctx: UiCtx): void {
		if (!ctx.hasUI || this.timer === null) return;
		if (this.repaintTimer !== null) return;
		this.repaintTimer = setTimeout(() => {
			this.repaintTimer = null;
			this.repaint(ctx);
		}, 0);
		this.repaintTimer.unref?.();
	}

	public handleSessionStart(ctx: UiCtx & { cwd?: string }): void {
		if (!ctx || !ctx.hasUI) return;
		try {
			ctx.ui?.setWorkingIndicator?.({ frames: [] });
		} catch {
			/* best-effort */
		}
		try {
			const safeCwd = typeof ctx.cwd === "string" ? sanitizeTitle(ctx.cwd) : "";
			const title = safeCwd ? `✻ ${safeCwd}` : "✻ pi";
			ctx.ui?.setTitle?.(title);
		} catch {
			/* best-effort */
		}
	}

	public handleAgentStart(ctx: UiCtx): void {
		this.verb = sampleVerb();
		activeWorkingVerb = this.verb;
		this.animStartMs = Date.now();
		this.settledTokens = 0;
		this.streamTokens = 0;
		this.currentTps = null;
		this.contentStreamStart = null;
		this.lastContentDeltaAt = null;
		this.contentCharacters = 0;
		this.firstContentDeltaCharacters = 0;
		this.firstReportedTokens = null;
		this.reportedStreamStart = null;
		this.lastReportedDeltaAt = null;
		this.runContentTokens = 0;
		this.runContentStreamMs = 0;
		this.clearThinkingTimers();
		this.clearRepaintTimer();
		this.thinkingStatus = null;
		this.thinkingStartMs = null;
		this.effortSuffix = "";
		this.stopLoop();
		if (!ctx.hasUI) return;
		this.selectAnimation(this.animStartMs);
		this.restartAnimationLoop(ctx);
		this.repaint(ctx);
	}

	public handleMessageUpdate(
		event: MessageUpdateEvent,
		ctx: UiCtx & { thinkingLevel?: string },
	): void {
		if (!event || typeof event !== "object") return;
		const ame = event.assistantMessageEvent;
		if (!ame || typeof ame !== "object") return;

		let changed = false;
		const usage =
			"partial" in ame && ame.partial && typeof ame.partial === "object"
				? ame.partial.usage
				: "message" in ame && ame.message && typeof ame.message === "object"
					? ame.message.usage
					: undefined;
		const out = usage?.output;
		if (
			typeof out === "number" &&
			Number.isFinite(out) &&
			!Number.isNaN(out) &&
			out >= 0 &&
			out !== this.streamTokens
		) {
			this.streamTokens = Math.floor(out);
			if (out > 0) {
				const now = Date.now();
				if (this.firstReportedTokens === null || out < this.firstReportedTokens) {
					this.firstReportedTokens = this.streamTokens;
					this.reportedStreamStart = now;
				}
				this.lastReportedDeltaAt = now;
			}
			changed = true;
		}
		if (
			ame.type === "text_delta" ||
			ame.type === "thinking_delta" ||
			ame.type === "toolcall_delta"
		) {
			const delta = typeof ame.delta === "string" ? ame.delta : "";
			if (delta.length > 0) {
				const now = Date.now();
				if (this.contentStreamStart === null) {
					this.contentStreamStart = now;
					this.firstContentDeltaCharacters = delta.length;
				}
				this.lastContentDeltaAt = now;
				this.contentCharacters += delta.length;
			}
		}
		const firstReported = this.firstReportedTokens;
		const reportedStart = this.reportedStreamStart;
		const hasReportedRate = firstReported !== null &&
			this.streamTokens > firstReported && reportedStart !== null;
		const elapsedMs = hasReportedRate
			? (this.lastReportedDeltaAt ?? reportedStart) - reportedStart
			: (this.lastContentDeltaAt ?? 0) - (this.contentStreamStart ?? 0);
		const streamedTokens = hasReportedRate
			? this.streamTokens - firstReported
			: (this.contentCharacters - this.firstContentDeltaCharacters) / 4;
		if (elapsedMs >= 200 && streamedTokens > 0) {
			this.currentTps = (this.runContentTokens + streamedTokens) /
				((this.runContentStreamMs + elapsedMs) / 1000);
			changed = true;
		}
		if (ame.type === "thinking_start") {
			this.effortSuffix = effortSuffixFor(
				typeof ctx?.thinkingLevel === "string" ? ctx.thinkingLevel : undefined,
			);
			this.beginThinking();
			changed = true;
		} else if (ame.type === "thinking_end") {
			this.settleThinking();
			changed = true;
		}
		if (changed && ctx?.hasUI && this.timer !== null) {
			this.scheduleRepaint(ctx);
		}
	}

	public handleMessageEnd(event: MessageEndEvent, ctx: UiCtx): void {
		if (
			!event ||
			typeof event !== "object" ||
			event.message?.role !== "assistant"
		)
			return;
		const msg = event.message;
		const usage =
			msg &&
			typeof msg === "object" &&
			"usage" in msg &&
			msg.usage &&
			typeof msg.usage === "object"
				? msg.usage
				: undefined;
		const out = usage?.output;
		const finalTokens =
			typeof out === "number" &&
			Number.isFinite(out) &&
			!Number.isNaN(out) &&
			out >= 0
				? Math.floor(out)
				: this.streamTokens;
		this.settledTokens += finalTokens;
		this.streamTokens = 0;

		// Exclude the first chunk (unknown generation time) and final delivery delay.
		// Providers without live usage are calibrated against their final token count.
		const firstReported = this.firstReportedTokens;
		const reportedStart = this.reportedStreamStart;
		const hasReportedRate = firstReported !== null &&
			finalTokens > firstReported && reportedStart !== null;
		const streamMs = hasReportedRate
			? Math.max(this.lastReportedDeltaAt ?? 0, this.lastContentDeltaAt ?? 0) - reportedStart
			: (this.lastContentDeltaAt ?? 0) - (this.contentStreamStart ?? 0);
		const remainingFraction = this.contentCharacters > 0
			? (this.contentCharacters - this.firstContentDeltaCharacters) / this.contentCharacters
			: 0;
		const streamedTokens = hasReportedRate
			? finalTokens - firstReported
			: typeof out === "number" && Number.isFinite(out) && out > 0
				? finalTokens * remainingFraction
				: (this.contentCharacters - this.firstContentDeltaCharacters) / 4;
		if (streamMs >= 50 && streamedTokens > 0) {
			this.runContentTokens += streamedTokens;
			this.runContentStreamMs += streamMs;
			this.currentTps = this.runContentTokens / (this.runContentStreamMs / 1000);
		}

		this.contentStreamStart = null;
		this.lastContentDeltaAt = null;
		this.contentCharacters = 0;
		this.firstContentDeltaCharacters = 0;
		this.firstReportedTokens = null;
		this.reportedStreamStart = null;
		this.lastReportedDeltaAt = null;

		this.settleThinking();
		if (ctx?.hasUI && this.timer !== null) {
			this.scheduleRepaint(ctx);
		}
	}

	public handleAgentEnd(): void {
		this.settleThinking();
	}

	public handleAgentSettled(ctx: UiCtx): void {
		this.currentTps = null;
		this.stopLoop();
		this.clearThinkingTimers();
		this.clearRepaintTimer();
		if (ctx.hasUI) {
			try {
				ctx.ui.setWorkingMessage();
			} catch {
				/* best-effort */
			}
		}
	}

	public handleSessionShutdown(): void {
		this.stopLoop();
		this.clearThinkingTimers();
		this.clearRepaintTimer();
	}

	public dispose(): void {
		this.stopLoop();
		this.clearThinkingTimers();
		this.clearRepaintTimer();
	}
}

export function registerSpinner(pi: ExtensionAPI): SpinnerController {
	const controller = new SpinnerController();

	pi.on("session_start", async (_event, ctx) => {
		controller.handleSessionStart(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		controller.handleAgentStart(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		controller.handleMessageUpdate(event, ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		controller.handleMessageEnd(event, ctx);
	});

	pi.on("agent_end", async () => {
		controller.handleAgentEnd();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		controller.handleAgentSettled(ctx);
	});

	pi.on("session_shutdown", async () => {
		controller.handleSessionShutdown();
	});

	return controller;
}
