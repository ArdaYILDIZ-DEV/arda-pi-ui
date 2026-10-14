import path from "node:path";
import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CacheTimerController } from "./cache-timer.ts";
import { colorizeRgb, formatCacheElapsed, getCacheColor } from "./cache-display.ts";
import { cacheReadPercent } from "./prompt-cache.ts";
import type { GitInfoController } from "./git-info.ts";
import { fg, resolvePalette, resolveThemeAppearance, resolveThemeColorMode, sanitizeControlChars, stripAnsi, themeText } from "./palette.ts";

export interface FooterState {
	readonly model: string;
	readonly cwd: string;
	readonly git: string;
	readonly context: ContextUsage | undefined;
	readonly cacheHitRate: number | undefined;
	readonly cacheTimer: string;
	readonly cacheExpired: boolean;
	readonly cacheRatio?: number;
	readonly cacheNeutral?: boolean;
	/** Session-wide recorded estimate; null means at least one usage has no price. */
	readonly cost?: number | null;
	readonly statuses: ReadonlyMap<string, string>;
}

export interface FooterPaint {
	accent(text: string): string;
	muted(text: string): string;
	warning(text: string): string;
	ttl?(text: string, ratio: number): string;
}

function clean(text: string): string {
	return sanitizeControlChars(stripAnsi(text).replace(/[\r\n\t]/g, " "))
		.replace(/\s+/g, " ").trim();
}

function formatTokens(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value) || value < 0) return "?";
	if (value < 1000) return String(Math.round(value));
	const divisor = value < 1_000_000 ? 1000 : 1_000_000;
	return `${Number((value / divisor).toFixed(1))}${divisor === 1000 ? "k" : "M"}`;
}

function formatCost(cost: number | null): string {
	if (cost === null || !Number.isFinite(cost) || cost < 0) return "$? est";
	if (cost > 0 && cost < 0.001) return "<$0.001 est";
	return `$${cost.toFixed(cost < 1 ? 3 : 2)} est`;
}

function footerPaint(theme?: Theme): FooterPaint {
	const scheme = resolveThemeAppearance(theme);
	const palette = resolvePalette(scheme);
	const colorMode = resolveThemeColorMode(theme);
	return {
		accent: (text) => themeText(theme, "accent", text, (value) => fg(palette.cc.claude, value, colorMode)),
		muted: (text) => themeText(theme, "muted", text, (value) => fg(palette.cc.inactive, value, colorMode)),
		warning: (text) => themeText(theme, "warning", text, (value) => fg(palette.cc.warning, value, colorMode)),
		ttl: (text, ratio) => colorizeRgb(text, getCacheColor(ratio, scheme), colorMode),
	};
}

/** The second row is fed entirely by the host's read-only extension status map. */
export function buildFooterLines(
	state: FooterState,
	width: number,
	paint: FooterPaint = footerPaint(),
): string[] {
	if (!Number.isFinite(width) || width < 1) return [];
	const columns = Math.floor(width);
	const separator = paint.accent(" | ");
	const folder = clean(path.basename(path.resolve(state.cwd)) || path.parse(state.cwd).root);
	const context = `${formatTokens(state.context?.tokens)} / ${formatTokens(state.context?.contextWindow)}`;
	const contextPaint = state.context?.percent != null && state.context.percent >= 90 ? paint.warning : paint.muted;
	const modelText = paint.accent(clean(state.model));
	const contextText = contextPaint(context);
	const parts = [
		{ role: "model", text: modelText },
		{ role: "folder", text: paint.muted(folder) },
		...(state.git ? [{ role: "git", text: paint.muted(clean(state.git)) }] : []),
		{ role: "context", text: contextText },
	];
	if (state.cacheHitRate !== undefined && Number.isFinite(state.cacheHitRate)) {
		parts.push({ role: "cache", text: paint.muted(`cache read ${Math.round(state.cacheHitRate)}%`) });
	}
	if (state.cacheTimer) {
		const text = clean(state.cacheTimer);
		const ratio = state.cacheRatio ?? (state.cacheExpired ? 1 : 0);
		parts.push({ role: "ttl", text: state.cacheNeutral ? paint.muted(text) : paint.ttl ? paint.ttl(text, ratio) : (state.cacheExpired ? paint.warning : paint.muted)(text) });
	}
	const fitPrimary = (budget: number): string => {
		if (budget < 1) return "";
		let selected = parts;
		for (const role of ["ttl", "cache", "git", "folder"]) {
			const line = selected.map((part) => part.text).join(separator);
			if (visibleWidth(line) <= budget) return line;
			selected = selected.filter((part) => part.role !== role);
		}
		const modelBudget = budget - visibleWidth(contextText) - visibleWidth(separator);
		if (modelBudget >= 1) {
			return truncateToWidth(modelText, modelBudget, "…") + separator + contextText;
		}
		if (visibleWidth(contextText) <= budget) return contextText;
		const percent = state.context?.percent;
		const percentage = typeof percent === "number" && Number.isFinite(percent) ? `${Math.round(percent)}%` : "?";
		const compactContext = contextPaint(`ctx ${percentage}`);
		if (visibleWidth(compactContext) <= budget) return compactContext;
		return visibleWidth(percentage) <= budget ? contextPaint(percentage) : contextPaint("?");
	};
	let primary = fitPrimary(columns);
	if (state.cost !== undefined) {
		const price = paint.accent(formatCost(state.cost));
		const priceWidth = visibleWidth(price);
		if (priceWidth >= columns) {
			primary = truncateToWidth(price, columns, "");
		} else {
			const left = fitPrimary(Math.max(0, columns - priceWidth - 2));
			primary = left + " ".repeat(columns - visibleWidth(left) - priceWidth) + price;
		}
	}
	const lines = [primary];
	const statuses = Array.from(state.statuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => clean(text))
		.filter(Boolean)
		.map((text) => paint.muted(text));
	if (statuses.length > 0) {
		lines.push(...wrapTextWithAnsi(statuses.join(separator), columns));
	}
	return lines;
}

export interface FooterOptions {
	readonly git?: GitInfoController;
	readonly cache?: CacheTimerController;
}

export function registerFooter(pi: ExtensionAPI, options: FooterOptions = {}): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || typeof ctx.ui?.setFooter !== "function") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const requestRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(requestRender);
			const unsubscribeGit = options.git?.addListener(requestRender);
			options.cache?.setFooterRenderer(requestRender, ctx);
			let statsKey: string | undefined;
			let cacheHitRate: number | undefined;
			let context: ContextUsage | undefined;
			let cost: number | null = 0;
			let disposed = false;

			return {
				invalidate() { statsKey = undefined; },
				dispose() {
					if (disposed) return;
					disposed = true;
					unsubscribeBranch();
					unsubscribeGit?.();
					options.cache?.setFooterRenderer(null);
				},
				render(width: number): string[] {
					const manager = ctx.sessionManager;
					const key = `${manager.getSessionId()}:${manager.getLeafId()}:${ctx.model?.provider}:${ctx.model?.id}:${ctx.model?.api}`;
					if (statsKey !== key) {
						context = ctx.getContextUsage() ?? (ctx.model?.contextWindow ? {
							tokens: null, contextWindow: ctx.model.contextWindow, percent: null,
						} : undefined);
						cacheHitRate = latestCacheHitRate(ctx);
						cost = recordedSessionCost(ctx);
						statsKey = key;
					}
					const git = options.git?.getState();
					const detectedBranch = footerData.getGitBranch() ?? (git?.isRepository ? git.branch : "");
					const sameBranch = git?.isRepository && (git.branch === detectedBranch ||
						(detectedBranch === "detached" && git.branch.startsWith("detached@")));
					const branch = sameBranch ? git.branch : detectedBranch;
					const changed = sameBranch ? git.changedFiles : 0;
					const cache = options.cache?.getState();
					const hasCache = cache?.isVisible && (cache.lastContextTimestamp !== null || cache.isProcessing);
					const level = ctx.model?.reasoning ? ` (${pi.getThinkingLevel()})` : "";
					return buildFooterLines({
						model: `${ctx.model?.name || ctx.model?.id || "no-model"}${level}`,
						cwd: ctx.cwd,
						git: branch ? `${branch}${changed > 0 ? ` +${changed}` : ""}` : "",
						context,
						cacheHitRate,
						cacheTimer: hasCache && options.cache ? `idle ${formatCacheElapsed(cache.elapsedMs)} / ${formatCacheElapsed(options.cache.getTtlMs()).replace(" 0sn", "")}` : "",
						cacheExpired: cache?.isExpired ?? false,
						cacheRatio: cache?.ratio,
						cost,
						statuses: footerData.getExtensionStatuses(),
					}, width, footerPaint(ctx.ui.theme ?? theme));
				},
			};
		});
	});
}

function recordedSessionCost(ctx: ExtensionContext): number | null {
	let total = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		const usage = entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
			? entry.usage
			: entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
				? entry.message.usage : undefined;
		if (!usage) {
			if (entry.type === "usage" || (entry.type === "message" && entry.message.role === "assistant")) return null;
			continue;
		}
		const cost = usage.cost?.total;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
		total += cost;
	}
	return Number.isFinite(total) ? total : null;
}

function latestCacheHitRate(ctx: ExtensionContext): number | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction") return undefined;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "pending" || message.stopReason === "deferred") return undefined;
		if (ctx.model?.provider && (message.provider !== ctx.model.provider || message.model !== ctx.model.id)) return undefined;
		return cacheReadPercent(message.usage);
	}
	return undefined;
}
