import path from "node:path";
import { VERSION, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex, mixColors, parseColor, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { DEFAULT_HEADER_CONFIG, parseHeaderConfig, readHeaderSettings, type HeaderConfig, type HeaderSettings } from "./header-settings.ts";
import { fg, resolvePalette, resolveThemeAppearance, resolveThemeColorMode, sanitizeControlChars, stripAnsi, themeText, visibleWidth } from "./palette.ts";
import { notifySafely } from "./pi-compat.ts";
import { buildHeaderLogo, HEADER_LOGO_LAST_FRAME, HEADER_LOGO_WIDTH, type HeaderLogoTone } from "./header-logo.ts";

export interface HeaderInfo {
	readonly version: string;
	readonly model: string;
	readonly thinking: string;
	readonly cwd: string;
	readonly skills: number;
	readonly packageSkills: number;
	readonly prompts: number;
	readonly packages: number;
}

const LAST_FRAME = HEADER_LOGO_LAST_FRAME;
const COLOR_HEX = {
	a: "#D97757", c: "#FB4934", r: "#E74C4C", o: "#E89032", y: "#D5AD32",
	g: "#37A65A", w: "#DFDFDF", b: "#388CDA", p: "#A76CD8",
} as const;

function clean(value: string): string {
	return sanitizeControlChars(stripAnsi(value).replace(/[\r\n\t]/g, " ")).replace(/\s+/g, " ").trim();
}

function headerPaint(config: HeaderConfig, theme?: Theme) {
	const appearance = resolveThemeAppearance(theme);
	const palette = resolvePalette(appearance).cc;
	const mode = resolveThemeColorMode(theme);
	let accent = config.color === "theme" ? palette.claude : COLOR_HEX[config.color];
	try {
		if (theme?.colors) {
			if (config.color === "theme") accent = colorToHex(theme.colors.accent);
		}
	} catch { /* Incomplete host theme: use the shared fallback palette. */ }
	// Explicit legacy colors remain recognizable, but avoid pale yellow/white on light backgrounds.
	if (appearance === "light" && config.color !== "theme") {
		accent = colorToHex(mixColors(parseColor(accent), parseColor("#202020"), config.color === "w" ? 0.65 : 0.2, "srgb"));
	}
	return {
		accent: (text: string) => config.color === "theme"
			? themeText(theme, "accent", text, (value) => fg(accent, value, mode))
			: fg(accent, text, mode),
		muted: (text: string) => themeText(theme, "muted", text, (value) => fg(palette.inactive, value, mode)),
		logo: (tone: HeaderLogoTone, text: string, row: number) => {
			if (tone === "white") return themeText(theme, "text", text, (value) => fg("#FFFFFF", value, mode));
			if (tone !== "logo") {
				const index = { red: 1, cyan: 6, green: 2, orange: 3 }[tone];
				return fg(index, text, mode);
			}
			const shade = config.grad ? Math.max(0, Math.min(3, row - 1)) * 0.15 : 0;
			return fg(colorToHex(mixColors(parseColor(accent), parseColor("#000000"), shade, "srgb")), text, mode);
		},
	};
}

/** Pure, width-bounded layout. All external text is cleaned before applying any styles. */
export function buildHeaderLines(
	config: HeaderConfig,
	info: HeaderInfo,
	width: number,
	theme?: Theme,
	frame = LAST_FRAME,
): string[] {
	if (config.disabled || !Number.isFinite(width) || width < 1) return [];
	const columns = Math.floor(width);
	const paint = headerPaint(config, theme);
	const version = `v${clean(info.version)}`;
	const title = config.ver === 2 ? paint.accent(`Pi ${version}`)
		: config.ver === 1 ? `${paint.accent("Pi")} ${paint.muted(version)}` : paint.muted(`Pi ${version}`);
	const model = [clean(info.model), clean(info.thinking)].filter(Boolean).join(" · ");
	const skills = config.pkg ? `${info.skills} skills + ${info.packageSkills} pkg skills` : `${info.skills} skills`;
	const summary = `${skills} · ${info.prompts} prompts · ${info.packages} packages`;
	const rows = [title];
	if (config.sloganOn && config.slogan) {
		rows.push((config.sloganColor ? paint.accent : paint.muted)(clean(config.slogan)));
	}
	rows.push(paint.muted(model), paint.muted(summary), paint.muted(clean(path.basename(info.cwd) || info.cwd)));
	const clip = (text: string, budget: number) => truncateToWidth(text, budget, "…");
	// Below 40 columns, prioritize readable information over a clipped side-by-side logo.
	if (columns < 40) return rows.map((row) => clip(row, columns));
	const gap = "  ";
	const budget = columns - HEADER_LOGO_WIDTH - gap.length;
	const infoRows = ["", ...rows];
	return buildHeaderLogo(frame, config.lines, paint.logo).map((mark, index) =>
		mark + " ".repeat(HEADER_LOGO_WIDTH - visibleWidth(mark)) + gap + clip(infoRows[index] ?? "", budget));
}

interface HeaderComponentOptions {
	readonly config: HeaderConfig;
	readonly info: () => HeaderInfo;
	readonly theme: () => Theme | undefined;
	readonly requestRender: () => void;
	readonly animate: boolean;
}

/** Owns only a finite entrance animation; the host disposes it on replacement. */
export class HeaderComponent implements Component {
	private readonly options: HeaderComponentOptions;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private frame: number;
	private disposed = false;

	constructor(options: HeaderComponentOptions) {
		this.options = options;
		this.frame = options.animate && !options.config.disabled ? 0 : LAST_FRAME;
		this.schedule();
	}

	private schedule(): void {
		if (this.disposed || this.frame >= LAST_FRAME) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.disposed) return;
			this.frame++;
			try { this.options.requestRender(); }
			catch { this.dispose(); return; }
			this.schedule();
		}, this.options.config.speed);
		this.timer.unref?.();
	}

	render(width: number): string[] {
		if (this.options.config.disabled) return [];
		return buildHeaderLines(this.options.config, this.options.info(), width, this.options.theme(), this.frame);
	}

	invalidate(): void { /* Read current model, resources and theme on every render. */ }

	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
	}
}

export interface HeaderOptions {
	readonly readSettings?: () => HeaderSettings;
}

function hasLegacyHeader(pi: ExtensionAPI): boolean {
	return pi.getCommands().some((command) => command.source === "extension" && (
		/^npm:pi-cc-header(?:@|$)/.test(command.sourceInfo.source) ||
		/(?:^|[/\\])pi-cc-header(?:[/\\]|\.ts$)/.test(command.sourceInfo.path)
	));
}

function headerInfo(pi: ExtensionAPI, ctx: ExtensionContext, packages: number): HeaderInfo {
	// Public command metadata describes registered resources without walking package directories.
	const commands = pi.getCommands();
	const skills = commands.filter((command) => command.source === "skill");
	const packageSkills = skills.filter((skill) => skill.sourceInfo.origin === "package").length;
	return {
		version: VERSION,
		model: ctx.model?.id ?? "no-model",
		thinking: pi.getThinkingLevel(),
		cwd: ctx.cwd,
		skills: skills.length - packageSkills,
		packageSkills,
		prompts: commands.filter((command) => command.source === "prompt").length,
		packages,
	};
}

/** Composition boundary: no terminal writes, screen clearing, or settings mutations. */
export function registerHeader(pi: ExtensionAPI, options: HeaderOptions = {}): void {
	const readSettings = options.readSettings ?? readHeaderSettings;
	let settings: HeaderSettings = { config: { ...DEFAULT_HEADER_CONFIG }, packages: 0, issues: [] };
	let active: HeaderComponent | undefined;
	const dispose = () => { active?.dispose(); active = undefined; };
	const load = (ctx: ExtensionContext) => {
		settings = readSettings();
		if (settings.issues.length) notifySafely(ctx, settings.issues.join("\n"), "warning");
	};
	const apply = (ctx: ExtensionContext, animate: boolean) => {
		dispose();
		if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.setHeader !== "function") return;
		if (hasLegacyHeader(pi)) {
			notifySafely(ctx, "arda-pi-ui header is inactive while pi-cc-header is loaded. Remove that package from settings and /reload to migrate.", "warning");
			return;
		}
		ctx.ui.setHeader((tui, theme) => {
			dispose();
			active = new HeaderComponent({
				config: settings.config,
				info: () => headerInfo(pi, ctx, settings.packages),
				theme: () => ctx.ui.theme ?? theme,
				requestRender: () => tui.requestRender(),
				animate,
			});
			return active;
		});
	};

	pi.on("session_start", (event, ctx) => {
		dispose();
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		load(ctx);
		// The host identifies resume/reload/fork; do not infer it from process arguments.
		apply(ctx, event.reason === "startup" || event.reason === "new");
	});
	pi.on("session_shutdown", dispose);
	pi.registerCommand("arda-header", {
		description: "Header status, on/off, reload, replay, reset, or <ccHeader key> <value> (session only)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			if (hasLegacyHeader(pi)) {
				notifySafely(ctx, "pi-cc-header is loaded; remove it from settings and /reload before using /arda-header.", "warning");
				return;
			}
			const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
			const key = match?.[1] ?? "status";
			const value = match?.[2] ?? "";
			if (key === "status") {
				notifySafely(ctx, `Header (session): ${JSON.stringify({ ...settings.config, slogan: clean(settings.config.slogan) })}`);
				return;
			}
			if (key === "replay") {
				apply(ctx, true);
				return;
			}
			if (key === "reload") load(ctx);
			else if (key === "reset") settings = { ...settings, config: { ...DEFAULT_HEADER_CONFIG } };
			else if (key === "on" || key === "off") settings = { ...settings, config: { ...settings.config, disabled: key === "off" } };
			else {
				if (!Object.hasOwn(DEFAULT_HEADER_CONFIG, key)) {
					notifySafely(ctx, "Invalid header key. Use status, on/off, reload, replay, reset, or a ccHeader key.", "warning");
					return;
				}
				const candidate = key === "slogan" || key === "color" ? value
					: key === "ver" || key === "speed" ? (value.trim() ? Number(value) : NaN)
					: value === "true" ? true : value === "false" ? false : value;
				const invalid: string[] = [];
				const config = parseHeaderConfig({ ...settings.config, [key]: candidate }, (field) => invalid.push(field));
				if (invalid.length) {
					notifySafely(ctx, "Invalid header value; settings were not changed.", "warning");
					return;
				}
				settings = { ...settings, config };
			}
			apply(ctx, false);
			notifySafely(ctx, "Header updated for this session only; settings.json was not changed.");
		},
	});
}
