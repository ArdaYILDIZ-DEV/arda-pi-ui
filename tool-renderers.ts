/**
 * Compact tool views through Pi's public renderer resolver.
 * Expanded views retain tool identity above the original renderer; execution is never replaced.
 * The older re-registration/prototype implementation remains a compatibility
 * path only for hosts without registerToolRenderer.
 */
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ToolDefinition,
	ToolRenderers,
	Theme,
} from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import type { Text } from "@earendil-works/pi-tui";
import { notifySafely } from "./pi-compat.ts";
import { ToolDiffComponent, parseDiffText } from "./tool-diff.ts";
import { sanitizeControlChars, sanitizeSafeAnsi, stripAnsi } from "./palette.ts";

const {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} = PiCodingAgent;

const MAX_SUMMARY_CHARS = 120;
const MAX_DIFF_PREVIEW_LINES = 12;
let piCompatibilityWarningLogged = false;

function warnPiCompatibility(feature: string): void {
	if (piCompatibilityWarningLogged) return;
	piCompatibilityWarningLogged = true;
	console.warn(`[arda-pi-ui] Pi ${feature} unavailable; using built-in renderers.`);
}

type RenderContext = {
	executionStarted: boolean;
	isError: boolean;
	isPartial: boolean;
	durationMs?: number;
	outputPad?: number;
};

function outputPadding(context: RenderContext): number {
	return typeof context.outputPad === "number" && Number.isFinite(context.outputPad)
		? Math.max(0, Math.floor(context.outputPad)) : 1;
}

type TextResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
};

function singleLine(text: string, maxLength = MAX_SUMMARY_CHARS): string {
	if (typeof text !== "string") return "";
	const compact = sanitizeControlChars(stripAnsi(text).replace(/\s+/g, " ")).trim();
	return compact.length > maxLength
		? `${compact.slice(0, maxLength - 1)}…`
		: compact;
}

function quote(value: string): string {
	if (typeof value !== "string") return "";
	return value.includes(" ") ? JSON.stringify(value) : value;
}

function resultText(result: TextResult): string {
	if (!result || !Array.isArray(result.content)) return "";
	return result.content
		.filter(
			(item) => item && item.type === "text" && typeof item.text === "string",
		)
		.map((item) => item.text as string)
		.join("\n")
		.trim();
}

function nonEmptyLineCount(text: string): number {
	if (typeof text !== "string" || !text) return 0;
	return text.split("\n").filter((line) => line.trim()).length;
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function outputWarnings(details: unknown): string[] {
	const value = recordValue(details);
	const warnings: string[] = [];
	if (recordValue(value.truncation).truncated === true) warnings.push("Output truncated · incomplete");
	for (const [key, label] of [
		["matchLimitReached", "Match"],
		["resultLimitReached", "Result"],
		["entryLimitReached", "Entry"],
	] as const) {
		if (positiveInteger(value[key])) warnings.push(`${label} limit reached (${value[key]}) · incomplete`);
	}
	if (value.linesTruncated === true) warnings.push("Lines truncated · incomplete");
	if (typeof value.fullOutputPath === "string" && value.fullOutputPath.trim()) {
		warnings.push(`Full output: ${value.fullOutputPath}`);
	}
	return warnings;
}

function durationSuffix(context: RenderContext): string {
	const ms = context.durationMs;
	return typeof ms === "number" && Number.isFinite(ms) && ms >= 0
		? ` · ${(ms / 1000).toFixed(1)}s` : "";
}

function expansionHint(theme: Theme): string {
	const hint = typeof PiCodingAgent.keyHint === "function"
		? PiCodingAgent.keyHint("app.tools.expand", "to expand") : "to expand";
	return theme.fg("dim", ` ${hint}`);
}

function lineSummary(noun: string, output: string): string {
	const count = nonEmptyLineCount(output);
	return count > 0
		? `${noun} ${count} ${count === 1 ? "line" : "lines"}`
		: "Done";
}

export function addAssistantResponseMarker(
	markdown: string,
	marker = "●",
): string {
	if (
		typeof markdown !== "string" ||
		!markdown.trim() ||
		markdown.startsWith(`${marker} `)
	)
		return markdown;

	// Claude renders its dot in a separate layout column. Pi only exposes a
	// Markdown transformer, so avoid prefixing block constructs whose parsing
	// would change when text is inserted before them.
	const firstLine = markdown.trimStart().split("\n", 1)[0]!;
	if (/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)/.test(firstLine))
		return markdown;
	return `${marker} ${markdown}`;
}

function renderCall(
	label: string,
	detail: string,
	theme: Theme,
	context: RenderContext,
): Text {
	const safeLabel = singleLine(label) || "Tool";
	let dotColor: "accent" | "error" | "success" = "accent";
	if (context.isError) dotColor = "error";
	else if (context.executionStarted && !context.isPartial) dotColor = "success";
	const suffix = detail ? theme.fg("muted", `  ${singleLine(detail)}`) : "";
	const state = context.isError ? "Failed"
		: !context.executionStarted ? "Preparing…"
		: context.isPartial ? "Working…" : "Completed";
	return new PiTui.Text(
		`${theme.fg(dotColor, "●")} ${theme.fg("toolTitle", theme.bold(safeLabel))}${suffix}${theme.fg(dotColor, ` · ${state}`)}`,
		outputPadding(context),
		0,
	);
}

function renderResult(
	result: TextResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
	summary: (output: string) => string,
): Text {
	const output = resultText(result);
	const isError = context.isError;
	const color = isError ? "error" : "dim";
	const completedSummary = !options.isPartial && !isError ? summary(output) : "";
	const completedStatus = completedSummary === "Done" ? "Completed"
		: completedSummary.startsWith("Completed ") ? completedSummary : `Completed · ${completedSummary}`;
	const status = options.isPartial ? `Working…${output ? ` · ${singleLine(output)}` : ""}`
		: isError ? `Failed${output ? ` · ${singleLine(output)}` : ""}`
		: completedStatus;
	let text = theme.fg(color, `  └ ${status}${options.isPartial ? "" : durationSuffix(context)}`);
	if (output && !options.expanded) text += expansionHint(theme);
	for (const warning of outputWarnings(result.details)) {
		text += `\n${theme.fg("warning", `    ${singleLine(warning, Infinity)}`)}`;
	}

	if (output && options.expanded) {
		// The expanded fallback is the final disclosure level: do not hide
		// available evidence behind a second, unreachable preview limit.
		for (const line of output.split("\n")) {
			text += `\n${theme.fg("toolOutput", `    ${sanitizeSafeAnsi(line)}`)}`;
		}
	}
	return new PiTui.Text(text, outputPadding(context), 0);
}

// ---------------------------------------------------------------------------
// Generic label / detail / summary for unknown (non-builtin) tools
// ---------------------------------------------------------------------------

const BUILTIN_LABELS: Readonly<Record<string, string>> = {
	read: "Read",
	bash: "Bash",
	powershell: "PowerShell",
	edit: "Edit",
	write: "Write",
	grep: "Grep",
	find: "Find",
	ls: "List",
};

const KNOWN_BUILTINS: readonly string[] = Object.keys(BUILTIN_LABELS);

// Builtins confirmed wrappable: seen as Pi-owned or previously wrapped by us.
// (Re-registration changes the registry source to our extension, so the
// "builtin" filter alone cannot find them again for re-enable/restore.)
// Never add third-party-overridden tools here — their execute must not be replaced.
const wrappableBuiltinNames = new Set<string>();

const BUILTIN_FACTORIES: Readonly<
	Record<string, (cwd: string) => ToolDefinition<any, any, any>>
> = {
	read: (cwd) => createReadToolDefinition(cwd),
	bash: (cwd) => createBashToolDefinition(cwd),
	powershell: (cwd) => createPowerShellToolDefinition(cwd),
	edit: (cwd) => createEditToolDefinition(cwd),
	write: (cwd) => createWriteToolDefinition(cwd),
	grep: (cwd) => createGrepToolDefinition(cwd),
	find: (cwd) => createFindToolDefinition(cwd),
	ls: (cwd) => createLsToolDefinition(cwd),
};

// Master switch for compact tool rendering (toggled via /arda-tools).
let claudeToolsEnabled = true;
let lastCwd: string | null = null;

export function isClaudeToolsEnabled(): boolean {
	return claudeToolsEnabled;
}

/** Builtins safe to wrap: Pi-owned, or previously wrapped by us. */
function getWrappableBuiltins(pi: ExtensionAPI): string[] {
	let entries: Array<{ name: string; source: string }>;
	try {
		entries = pi
			.getAllTools()
			.map((tool) => ({ name: tool.name, source: tool.sourceInfo.source }));
	} catch {
		return [];
	}
	return KNOWN_BUILTINS.filter((name) =>
		entries.some(
			(entry) =>
				entry.name === name &&
				(entry.source === "builtin" || wrappableBuiltinNames.has(name)),
		),
	);
}

/** Human-readable Claude-style label. `ask_user_question` -> `Ask User Question`. */
export function prettyToolLabel(name: string): string {
	if (typeof name !== "string" || !name) return "Tool";
	const known = (BUILTIN_LABELS as Record<string, string>)[name];
	if (known) return known;
	const words = name
		.split(/[_-]+/)
		.map((w) => w.trim())
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1));
	if (words.length === 0) return "Tool";
	return words.join(" ");
}

const DETAIL_KEYS = [
	"command",
	"pattern",
	"question",
	"query",
	"url",
	"prompt",
	"text",
	"input",
	"path",
	"file_path",
	"file",
	"dir",
	"directory",
] as const;

/** Heuristic primary arg for generic tools: first known string key, else first string value. */
export function genericDetail(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of DETAIL_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	for (const value of Object.values(record)) {
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

/** Generic collapsed summary: `Completed N lines` or `Done`. */
export function genericSummary(output: string): string {
	return lineSummary("Completed", output);
}

function builtinDetail(toolName: string, args: unknown): string {
	const value = recordValue(args);
	const path = typeof value.path === "string" ? value.path : "";
	const parts: string[] = [];
	if (toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "ls") {
		parts.push(path || (toolName === "ls" ? "." : ""));
		if (toolName === "read" && positiveInteger(value.offset)) parts.push(`offset: ${value.offset}`);
	} else if (toolName === "grep" || toolName === "find") {
		parts.push(typeof value.pattern === "string" ? JSON.stringify(value.pattern) : "", path || ".");
		if (toolName === "grep" && typeof value.glob === "string" && value.glob) parts.push(`glob: ${value.glob}`);
	} else {
		return genericDetail(args);
	}
	if (["read", "grep", "find", "ls"].includes(toolName) && positiveInteger(value.limit)) parts.push(`limit: ${value.limit}`);
	return parts.filter(Boolean).join(" · ");
}

function genericRenderCall(
	args: unknown,
	theme: Theme,
	context: RenderContext,
	toolName: string,
): Text {
	const label = prettyToolLabel(toolName);
	const detail = builtinDetail(toolName, args);
	return renderCall(label, detail, theme, context);
}

function genericRenderResult(
	result: TextResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Text {
	return renderResult(result, options, theme, context, genericSummary);
}

function padOriginal(component: PiTui.Component, base: ToolRenderers, context: RenderContext): PiTui.Component {
	if (base.renderShell === "self") return component;
	const box = new PiTui.Box(outputPadding(context), 0);
	box.addChild(component);
	return box;
}

function builtinSummary(toolName: string, output: string): string {
	if (toolName === "write") return "Written";
	if (toolName === "edit") return "Updated";
	const noun = toolName === "read" ? "Read"
		: toolName === "bash" || toolName === "powershell" ? "Returned"
		: toolName === "grep" || toolName === "find" ? "Found"
		: toolName === "ls" ? "Listed" : "Completed";
	return lineSummary(noun, output);
}

function compactToolRenderers(toolName: string, base?: ToolRenderers): ToolRenderers {
	// Pi passes our last outer component back on every redraw. Native renderers
	// must instead receive their own previous component, isolated per execution
	// and render slot. Weak keys allow finished tool rows to be collected.
	const callComponents = new WeakMap<object, PiTui.Component>();
	const resultComponents = new WeakMap<object, PiTui.Component>();
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			if (!context.expanded) return genericRenderCall(args, theme, context, toolName);
			const container = new PiTui.Container();
			container.addChild(renderCall(prettyToolLabel(toolName), "", theme, context));
			// Native edit call renderers can embed their own diff preview.
			// Keep edit identity/path here and render its diff only in our result.
			if (base?.renderCall && toolName !== "edit") {
				const original = base.renderCall(args, theme, { ...context, lastComponent: callComponents.get(context.state) });
				if (context.state && typeof context.state === "object") callComponents.set(context.state, original);
				container.addChild(padOriginal(original, base, context));
			} else {
				const detail = builtinDetail(toolName, args);
				if (detail) {
					const safeDetail = detail.split("\n").map(sanitizeSafeAnsi).join("\n");
					container.addChild(new PiTui.Text(theme.fg("toolOutput", safeDetail), outputPadding(context), 0));
				}
			}
			return container;
		},
		renderResult(result, options, theme, context) {
			const showOriginal = (toolName !== "edit" || context.isError) &&
				(options.expanded || (!context.isError && result.content.some((item) => item.type === "image")));
			if (base?.renderResult && (showOriginal || resultComponents.has(context.state))) {
				// Keep a visited native renderer up to date while collapsed, so its
				// final-result cleanup still runs (e.g. shell elapsed-time intervals).
				const original = base.renderResult(result, options, theme, { ...context, lastComponent: resultComponents.get(context.state) });
				if (context.state && typeof context.state === "object") resultComponents.set(context.state, original);
				if (showOriginal) return padOriginal(original, base, context);
			}
			if (context.isError) {
				return genericRenderResult(result, options, theme, context);
			}
			if (toolName === "edit" && !options.isPartial) {
				const diff = recordValue(result.details).diff;
				if (typeof diff === "string" && diff.trim()) {
					const { lines } = parseDiffText(diff);
					const added = lines.filter((line) => line.type === "added").length;
					const removed = lines.filter((line) => line.type === "removed").length;
					const summary = renderResult({ content: [], details: result.details }, options, theme, context,
						() => `Updated · +${added} / −${removed} lines`);
					const container = new PiTui.Container();
					container.addChild(summary);
					if (options.expanded || lines.length <= MAX_DIFF_PREVIEW_LINES) {
						const args = context.args as { path?: string; file_path?: string } | undefined;
						container.addChild(new ToolDiffComponent(diff, args?.path ?? args?.file_path ?? "", theme, outputPadding(context)));
					} else {
						container.addChild(new PiTui.Text(theme.fg("dim", "    Changes hidden ·") + expansionHint(theme), outputPadding(context), 0));
					}
					return container;
				}
			}
			if (result.content.some((item) => item.type === "image") && !options.expanded) {
				return new PiTui.Text(theme.fg("dim", "  └ Image result (expand to view)"), outputPadding(context), 0);
			}
			return renderResult(result, options, theme, context, (output) => builtinSummary(toolName, output));
		},
	};
}

// ---------------------------------------------------------------------------
// Compatibility path for older Pi hosts without registerToolRenderer
// ---------------------------------------------------------------------------

/**
 * Register compact render-only overrides for Pi-owned local built-in tools.
 * Wrapped names are remembered for re-enable/restore cycles (/arda-tools).
 * Returns the list of wrapped tool names (useful for tests).
 */
export function registerClaudeToolRenderers(
	pi: ExtensionAPI,
	cwd: string,
): string[] {
	const wrapped: string[] = [];
	if (typeof PiTui.Text !== "function") {
		warnPiCompatibility("Text component");
		return wrapped;
	}
	const piOwnedTools = new Set(getWrappableBuiltins(pi));
	const safeCwd = typeof cwd === "string" && cwd ? cwd : process.cwd();

	for (const name of KNOWN_BUILTINS) {
		if (!piOwnedTools.has(name)) continue;
		try {
			const tool = BUILTIN_FACTORIES[name]!(safeCwd);
			pi.registerTool({
				...tool,
				renderShell: "self",
				renderCall(args, theme, context) {
					const a = args as { path?: string; command?: string; pattern?: string };
					const detail = name === "grep" || name === "find"
						? `${quote(a.pattern ?? "")}${a.path ? ` in ${a.path}` : ""}`
						: name === "bash" || name === "powershell"
							? a.command ?? ""
							: a.path ?? (name === "ls" ? "." : "");
					return renderCall(BUILTIN_LABELS[name]!, detail, theme, context);
				},
				renderResult(result, options, theme, context) {
					// Legacy edit results own the diff even when expanded; errors
					// must stay in the generic diagnostic view, ahead of the diff.
					if (name === "edit") {
						if (context.isError) {
							return renderResult(result, options, theme, context, () => "Failed");
						}
						const diff = (result.details as { diff?: unknown } | undefined)?.diff;
						if (typeof diff === "string" && diff.trim()) {
							const args = context.args as { path?: string; file_path?: string } | undefined;
							return new ToolDiffComponent(diff, args?.path ?? args?.file_path ?? "", theme);
						}
					}
					// Preserve the legacy read contract: only a first-block image
					// selects the native renderer while collapsed.
					if ((options.expanded || (name === "read" && result.content[0]?.type === "image")) && tool.renderResult) {
						return tool.renderResult(result, options, theme, context);
					}
					return renderResult(result, options, theme, context, (output) => builtinSummary(name, output));
				},
			});
			wrapped.push(name);
		} catch {
			/* best-effort: keep the original definition and continue */
		}
	}

	for (const name of wrapped) wrappableBuiltinNames.add(name);
	return wrapped;
}

/**
 * Restore the original Pi renderers for builtins wrapped by us.
 * Re-registers the plain factory definitions (execute + renderers untouched).
 * Names stay in the wrappable set so a later enable works again.
 * Returns the list of restored tool names.
 */
export function restoreBuiltinToolRenderers(
	pi: ExtensionAPI,
	cwd: string,
): string[] {
	const restored: string[] = [];
	const safeCwd =
		typeof cwd === "string" && cwd ? cwd : (lastCwd ?? process.cwd());
	let present: Set<string>;
	try {
		present = new Set(pi.getAllTools().map((tool) => tool.name));
	} catch {
		return restored;
	}
	for (const name of wrappableBuiltinNames) {
		if (!present.has(name)) continue;
		const factory = BUILTIN_FACTORIES[name];
		if (!factory) continue;
		try {
			pi.registerTool(factory(safeCwd));
			restored.push(name);
		} catch {
			/* best-effort: keep current renderer */
		}
	}
	return restored;
}

/**
 * Flip the master switch. Enable re-applies compact renderers + global patch,
 * disable restores Pi default renderers + removes the global patch.
 * Returns the list of (re-)registered tool names.
 */
export function setClaudeToolsEnabled(
	pi: ExtensionAPI,
	enabled: boolean,
	cwd?: string,
): string[] {
	claudeToolsEnabled = enabled;
	const targetCwd =
		typeof cwd === "string" && cwd ? cwd : (lastCwd ?? process.cwd());
	lastCwd = targetCwd;
	// Pi 1.x resolves display separately; toggling must not replace tool execution.
	if (typeof pi.registerToolRenderer === "function") return [];
	if (claudeToolsEnabled) {
		try {
			installGlobalClaudeToolPatch();
		} catch {
			/* best-effort */
		}
		try {
			return registerClaudeToolRenderers(pi, targetCwd);
		} catch {
			return [];
		}
	}
	try {
		uninstallGlobalClaudeToolPatch();
	} catch {
		/* best-effort */
	}
	try {
		return restoreBuiltinToolRenderers(pi, targetCwd);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Global fallback: prototype patch so *every* tool renders Claude-style
// ---------------------------------------------------------------------------

type PatchedProto = {
	__ccUiToolPatchInstalled?: boolean;
	__ccUiOrigGetCallRenderer?: (...args: unknown[]) => unknown;
	__ccUiOrigGetResultRenderer?: (...args: unknown[]) => unknown;
	__ccUiOrigGetRenderShell?: (...args: unknown[]) => unknown;
	__ccUiOrigHasRendererDefinition?: (...args: unknown[]) => unknown;
};

function getPatchTarget(warnIfUnavailable = true): PatchedProto | null {
	try {
		// SAFETY: ToolExecutionComponent is an exported Pi class whose prototype shape
		// is not in its public d.ts (private render methods); we only read the
		// prototype object to install a best-effort UI fallback, never to change types.
		const component = PiCodingAgent.ToolExecutionComponent as
			| { prototype?: PatchedProto }
			| undefined;
		const proto = component?.prototype;
		if (!proto || typeof proto !== "object") {
			if (warnIfUnavailable) warnPiCompatibility("tool renderer component");
			return null;
		}
		return proto;
	} catch {
		return null;
	}
}

export function isGlobalClaudeToolPatchInstalled(): boolean {
	const proto = getPatchTarget();
	return Boolean(proto?.__ccUiToolPatchInstalled);
}

function isClaudeWrapped(fn: unknown): boolean {
	if (typeof fn !== "function") return false;
	// SAFETY: flag check on a function object; the cast only reads an optional
	// boolean marker we set ourselves in markClaudeWrapped, no type change.
	return (fn as { __ccUiClaudeWrapped?: boolean }).__ccUiClaudeWrapped === true;
}

function markClaudeWrapped<T extends (...args: any[]) => any>(fn: T): T {
	try {
		(fn as { __ccUiClaudeWrapped?: boolean }).__ccUiClaudeWrapped = true;
	} catch {
		/* ignore */
	}
	return fn;
}

export type ClaudeCallContext = RenderContext & { expanded?: boolean };

/** Named renderer types returned by the global patch (avoids `unknown` returns). */
export type ClaudeCallRenderer = (
	args: unknown,
	theme: Theme,
	context: ClaudeCallContext,
) => Text;
export type ClaudeResultRenderer = (
	result: TextResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
) => Text;

/**
 * Install the global Claude-style fallback for all non-builtin tools.
 * Idempotent: returns true when the patch is active, false when the Pi
 * internals are unavailable (patch skipped, builtin path still works).
 */
export function installGlobalClaudeToolPatch(): boolean {
	if (typeof PiTui.Text !== "function") {
		warnPiCompatibility("Text component");
		return false;
	}
	const proto = getPatchTarget();
	if (!proto) return false;
	if (proto.__ccUiToolPatchInstalled) return true;

	try {
		const anyProto = proto as Record<string, unknown>;
		const origGetCall = anyProto["getCallRenderer"];
		const origGetResult = anyProto["getResultRenderer"];
		const origGetShell = anyProto["getRenderShell"];
		const origHasRenderer = anyProto["hasRendererDefinition"];
		if (
			typeof origGetCall !== "function" ||
			typeof origGetResult !== "function" ||
			typeof origGetShell !== "function"
		) {
			warnPiCompatibility("tool renderer prototype methods");
			return false;
		}

		proto.__ccUiOrigGetCallRenderer = origGetCall as (
			...args: unknown[]
		) => unknown;
		proto.__ccUiOrigGetResultRenderer = origGetResult as (
			...args: unknown[]
		) => unknown;
		proto.__ccUiOrigGetRenderShell = origGetShell as (
			...args: unknown[]
		) => unknown;
		if (typeof origHasRenderer === "function") {
			proto.__ccUiOrigHasRendererDefinition = origHasRenderer as (
				...args: unknown[]
			) => unknown;
		}

		// Tools without any definition (unknown sdk tools) fall back to a raw
		// JSON dump. Force the renderer path so they also get Claude styling.
		if (typeof origHasRenderer === "function") {
			const origHas = origHasRenderer as (this: unknown) => boolean;
			// SAFETY: Pi declares these renderer accessors private; at runtime they are
			// plain prototype methods, so assigning a same-signature function is safe
			// and fully reversible via uninstallGlobalClaudeToolPatch.
			(anyProto["hasRendererDefinition"] as unknown as (
				this: unknown,
			) => boolean) = function (this: unknown): boolean {
				try {
					if (origHas.call(this)) return true;
				} catch {
					/* fall through to generic renderer */
				}
				return true;
			};
		}

		// Always use the compact self-rendered frame.
		// SAFETY: same as above — replaces a private prototype accessor with a
		// same-shape function returning the constant Claude frame style.
		(anyProto["getRenderShell"] as unknown as (this: unknown) => string) =
			function (this: unknown): string {
				return "self";
			};

		// SAFETY: same prototype-patch invariant as above; returns a named
		// ClaudeCallRenderer (or undefined via the original) instead of unknown.
		(anyProto["getCallRenderer"] as unknown as (
			this: unknown,
		) => ClaudeCallRenderer | undefined) = function (
			this: unknown,
		): ClaudeCallRenderer | undefined {
			const self = this as { toolName?: unknown };
			const toolName = typeof self.toolName === "string" ? self.toolName : "tool";
			// Known builtins already have an official override via
			// registerClaudeToolRenderers — leave them untouched so the two
			// paths never fight each other.
			if ((KNOWN_BUILTINS as readonly string[]).includes(toolName)) {
				try {
					// SAFETY: original accessor returns a call renderer or undefined;
					// the cast only narrows the unknown boundary to our named type.
					const orig = proto.__ccUiOrigGetCallRenderer as unknown as
						| ((this: unknown) => ClaudeCallRenderer | undefined)
						| undefined;
					return orig?.call(this);
				} catch {
					return undefined;
				}
			}
			let original: unknown;
			try {
				// SAFETY: same narrowing as above; original may be any renderer shape.
				const orig = proto.__ccUiOrigGetCallRenderer as unknown as
					| ((this: unknown) => unknown)
					| undefined;
				original = orig?.call(this);
			} catch {
				original = undefined;
			}
			if (isClaudeWrapped(original)) {
				// SAFETY: already our wrapper, verified by marker flag above.
				return original as ClaudeCallRenderer;
			}
			const wrapped = (
				args: unknown,
				theme: Theme,
				context: ClaudeCallContext,
			): Text => {
				// Preserve rich custom call views when the user expands the row.
				if (context?.expanded && typeof original === "function") {
					try {
						return (original as (a: unknown, t: Theme, c: ClaudeCallContext) => Text)(
							args,
							theme,
							context,
						);
					} catch {
						/* fall through to compact view */
					}
				}
				return genericRenderCall(args, theme, context, toolName);
			};
			return markClaudeWrapped(wrapped);
		};

		// SAFETY: same prototype-patch invariant as above; returns a named
		// ClaudeResultRenderer (or undefined via the original) instead of unknown.
		(anyProto["getResultRenderer"] as unknown as (
			this: unknown,
		) => ClaudeResultRenderer | undefined) = function (
			this: unknown,
		): ClaudeResultRenderer | undefined {
			const self = this as { toolName?: unknown };
			const toolName = typeof self.toolName === "string" ? self.toolName : "tool";
			if ((KNOWN_BUILTINS as readonly string[]).includes(toolName)) {
				try {
					// SAFETY: original accessor returns a result renderer or undefined;
					// the cast only narrows the unknown boundary to our named type.
					const orig = proto.__ccUiOrigGetResultRenderer as unknown as
						| ((this: unknown) => ClaudeResultRenderer | undefined)
						| undefined;
					return orig?.call(this);
				} catch {
					return undefined;
				}
			}
			let original: unknown;
			try {
				// SAFETY: same narrowing as above; original may be any renderer shape.
				const orig = proto.__ccUiOrigGetResultRenderer as unknown as
					| ((this: unknown) => unknown)
					| undefined;
				original = orig?.call(this);
			} catch {
				original = undefined;
			}
			if (isClaudeWrapped(original)) {
				// SAFETY: already our wrapper, verified by marker flag above.
				return original as ClaudeResultRenderer;
			}
			const wrapped = (
				result: TextResult,
				options: { expanded: boolean; isPartial: boolean },
				theme: Theme,
				context: RenderContext,
			): Text => {
				// Expanded view keeps the tool's own rich renderer (images,
				// diffs, ...). Collapsed view is always the compact summary.
				if (options?.expanded && typeof original === "function") {
					try {
						return (original as typeof wrapped)(result, options, theme, context);
					} catch {
						/* fall through to compact view */
					}
				}
				// Image results without an expanded custom renderer: avoid
				// dumping binary as text, show a short placeholder instead.
				try {
					const hasImage =
						Array.isArray((result as TextResult)?.content) &&
						(result as TextResult).content.some((item) => item?.type === "image");
					if (hasImage && !options?.expanded) {
						return new PiTui.Text(
							theme.fg("dim", "  └ Image result (expand to view)"),
							1,
							0,
						);
					}
				} catch {
					/* ignore */
				}
				return genericRenderResult(result, options, theme, context);
			};
			return markClaudeWrapped(wrapped);
		};

		proto.__ccUiToolPatchInstalled = true;
		return true;
	} catch {
		return false;
	}
}

/** Restore the original ToolExecutionComponent renderers (mainly for tests). */
export function uninstallGlobalClaudeToolPatch(): boolean {
	const proto = getPatchTarget();
	if (!proto || !proto.__ccUiToolPatchInstalled) return false;
	try {
		const anyProto = proto as Record<string, unknown>;
		if (typeof proto.__ccUiOrigGetCallRenderer === "function") {
			anyProto["getCallRenderer"] = proto.__ccUiOrigGetCallRenderer;
		}
		if (typeof proto.__ccUiOrigGetResultRenderer === "function") {
			anyProto["getResultRenderer"] = proto.__ccUiOrigGetResultRenderer;
		}
		if (typeof proto.__ccUiOrigGetRenderShell === "function") {
			anyProto["getRenderShell"] = proto.__ccUiOrigGetRenderShell;
		}
		if (typeof proto.__ccUiOrigHasRendererDefinition === "function") {
			anyProto["hasRendererDefinition"] = proto.__ccUiOrigHasRendererDefinition;
		}
		delete proto.__ccUiOrigGetCallRenderer;
		delete proto.__ccUiOrigGetResultRenderer;
		delete proto.__ccUiOrigGetRenderShell;
		delete proto.__ccUiOrigHasRendererDefinition;
		delete proto.__ccUiToolPatchInstalled;
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// arda-pi-ui wiring: public resolver, with legacy-host compatibility
// ---------------------------------------------------------------------------

/** Register the render-only resolver and compact-view commands. */
export function registerToolRenderers(pi: ExtensionAPI): void {
	if (typeof pi.registerToolRenderer === "function") {
		// A reload can retain the prototype modified by the previous extension.
		if (getPatchTarget(false)?.__ccUiToolPatchInstalled && !uninstallGlobalClaudeToolPatch()) {
			throw new Error("Cannot restore the previous compact-tool prototype patch.");
		}
		pi.registerToolRenderer((toolName, next) => {
			const base = next();
			return claudeToolsEnabled ? compactToolRenderers(toolName, base) : base;
		});
	}
	const command: Parameters<ExtensionAPI["registerCommand"]>[1] = {
		description:
			"Kompakt araç görünümünü aç/kapat (arda-tools on/off/toggle)",
		handler: async (args, ctx) => {
			const clean = (typeof args === "string" ? args : "").trim().toLowerCase();
			if (clean === "on" || clean === "ac" || clean === "aç") {
				setClaudeToolsEnabled(pi, true, ctx.cwd);
				notifySafely(ctx, "Kompakt araç görünümü: açık", "info");
				return;
			}
			if (
				clean === "off" ||
				clean === "kapat" ||
				clean === "kapali" ||
				clean === "kapalı"
			) {
				setClaudeToolsEnabled(pi, false, ctx.cwd);
				notifySafely(ctx, "Kompakt araç görünümü: kapalı", "info");
				return;
			}
			if (clean === "toggle") {
				const next = !isClaudeToolsEnabled();
				setClaudeToolsEnabled(pi, next, ctx.cwd);
				notifySafely(ctx, `Kompakt araç görünümü: ${next ? "açık" : "kapalı"}`, "info");
				return;
			}
			notifySafely(
				ctx,
				`Kompakt araç görünümü: ${isClaudeToolsEnabled() ? "açık" : "kapalı"}. ` +
					`Kullanım: arda-tools on/off/toggle.`,
				"info",
			);
		},
	};
	pi.registerCommand("arda-tools", command);

	pi.on("session_start", async (_event, ctx) => {
		try {
			if (ctx.mode !== "tui") return;
		} catch {
			return;
		}
		try {
			lastCwd = ctx.cwd;
		} catch {
			/* ignore */
		}
		if (typeof pi.registerToolRenderer === "function") return;
		if (!claudeToolsEnabled) {
			try {
				uninstallGlobalClaudeToolPatch();
			} catch {
				/* best-effort */
			}
			try {
				restoreBuiltinToolRenderers(pi, ctx.cwd);
			} catch {
				/* best-effort */
			}
			return;
		}
		try {
			installGlobalClaudeToolPatch();
		} catch {
			/* best-effort */
		}
		try {
			registerClaudeToolRenderers(pi, ctx.cwd);
		} catch {
			/* best-effort: keep Pi default rendering */
		}
	});
}
