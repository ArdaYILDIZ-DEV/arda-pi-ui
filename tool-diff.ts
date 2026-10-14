/**
 * Claude Code style diff renderer for the edit tool.
 *
 * Renders diffs with:
 * - Line numbers and signs: `<lineNum> <sign> <code>` (e.g. `60 + `, `54 - `, `61   `)
 * - Full-width backgrounds derived from the active theme's diff colors and tool surfaces
 * - Bounded, dependency-free intra-line token diffing with highlighted word backgrounds
 * - Syntax highlighting via Pi theme & highlightCode
 * - Responsive terminal width padding and line wrapping with continuation gutter
 */

import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import { diffWords, type Change } from "./word-diff.ts";
import {
	bgAnsi,
	fgAnsi,
	FG_DEFAULT,
	RESET,
	resolvePalette,
	resolveThemeAppearance,
	resolveThemeColorMode,
	sanitizeControlChars,
	stripAnsi,
	visibleWidth,
} from "./palette.ts";

let compatibilityWarningLogged = false;

function warnCompatibilityFallback(feature: string, error?: unknown): void {
	if (compatibilityWarningLogged) return;
	compatibilityWarningLogged = true;
	console.warn(`[arda-pi-ui] Pi ${feature} unavailable; diff rendering is simplified.`, error);
}

function wrapTextWithAnsi(text: string, width: number): string[] {
	if (typeof PiTui.wrapTextWithAnsi === "function") {
		try {
			const wrapped = PiTui.wrapTextWithAnsi(text, width);
			if (
				Array.isArray(wrapped) &&
				wrapped.length > 0 &&
				wrapped.every((line) => typeof line === "string")
			) {
				return wrapped;
			}
			warnCompatibilityFallback("line wrapping API");
		} catch (error) {
			warnCompatibilityFallback("line wrapping API", error);
		}
	} else {
		warnCompatibilityFallback("line wrapping API");
	}
	return [text];
}

export interface DiffLine {
	readonly type: "added" | "removed" | "context" | "ellipsis";
	readonly lineNum?: number;
	readonly content: string;
	readonly cleanContent: string;
	highlighted: string;
	wordParts?: Change[];
}

export interface DiffThemeColors {
	readonly diffAddedBg: string;
	readonly diffAddedWord: string;
	readonly diffAddedGutter: string;
	readonly diffRemovedBg: string;
	readonly diffRemovedWord: string;
	readonly diffRemovedGutter: string;
	readonly diffContextGutter: string;
}

export function getDiffThemeColors(
	theme?: Theme | { name?: string },
): DiffThemeColors {
	if (theme && "colors" in theme) {
		const colors = theme.colors;
		return {
			diffAddedBg: PiTui.colorToHex(PiTui.mixColors(colors.toolSuccessBg, colors.toolDiffAdded, 0.12, "srgb")),
			diffAddedWord: PiTui.colorToHex(PiTui.mixColors(colors.toolSuccessBg, colors.toolDiffAdded, 0.28, "srgb")),
			diffAddedGutter: PiTui.colorToHex(colors.toolDiffAdded),
			diffRemovedBg: PiTui.colorToHex(PiTui.mixColors(colors.toolErrorBg, colors.toolDiffRemoved, 0.12, "srgb")),
			diffRemovedWord: PiTui.colorToHex(PiTui.mixColors(colors.toolErrorBg, colors.toolDiffRemoved, 0.28, "srgb")),
			diffRemovedGutter: PiTui.colorToHex(colors.toolDiffRemoved),
			diffContextGutter: PiTui.colorToHex(colors.toolDiffContext),
		};
	}
	const palette = resolvePalette(resolveThemeAppearance(theme));
	if (palette.scheme === "light") {
		return {
			diffAddedBg: "#D7EAD9",
			diffAddedWord: "#B2D8B6",
			diffAddedGutter: "#2E7D32",
			diffRemovedBg: "#F7D8DC",
			diffRemovedWord: "#EEB5BD",
			diffRemovedGutter: "#C62828",
			diffContextGutter: "#767676",
		};
	}
	return {
		diffAddedBg: "#0d3516",
		diffAddedWord: "#1f5926",
		diffAddedGutter: "#4EBA65",
		diffRemovedBg: "#420c10",
		diffRemovedWord: "#7a2936",
		diffRemovedGutter: "#FF6B80",
		diffContextGutter: "#6B7280",
	};
}

/**
 * Parses Pi diff output string (from generateDiffString) into structured lines.
 * Format of input lines:
 * "+ 60 content" or "+60 content"
 * "- 54 content" or "-54 content"
 * "  61 content"
 * "     ..."
 */
export function parseDiffText(diffText: string): {
	lines: DiffLine[];
	maxLineNum: number;
} {
	if (!diffText || typeof diffText !== "string") {
		return { lines: [], maxLineNum: 1 };
	}

	const rawLines = diffText.split(/\r?\n/);
	// Drop trailing blank line produced by split on trailing newline
	if (
		rawLines.length > 0 &&
		rawLines[rawLines.length - 1] === "" &&
		diffText.endsWith("\n")
	) {
		rawLines.pop();
	}

	const lines: DiffLine[] = [];
	let maxLineNum = 1;

	for (const rawLine of rawLines) {
		const match = rawLine.match(/^([+-\s])(\s*\d*)\s(.*)$/);
		if (!match) {
			const trimmed = sanitizeControlChars(stripAnsi(rawLine)).trim();
			if (trimmed.length > 0) {
				lines.push({
					type: "ellipsis",
					content: trimmed,
					cleanContent: trimmed,
					highlighted: trimmed,
				});
			}
			continue;
		}

		const prefix = match[1]!;
		const numStr = match[2]!.trim();
		const content = match[3] ?? "";
		const cleanContent = sanitizeControlChars(stripAnsi(content).replace(/\t/g, "   "));
		const lineNum = numStr.length > 0 ? parseInt(numStr, 10) : undefined;

		if (lineNum !== undefined && !Number.isNaN(lineNum) && lineNum > maxLineNum) {
			maxLineNum = lineNum;
		}

		let type: DiffLine["type"] = "context";
		if (prefix === "+") {
			type = "added";
		} else if (prefix === "-") {
			type = "removed";
		} else if (!numStr && cleanContent.startsWith("...")) {
			type = "ellipsis";
		}

		lines.push({
			type,
			lineNum,
			content,
			cleanContent,
			highlighted: cleanContent,
		});
	}

	return { lines, maxLineNum };
}

interface WordRange {
	start: number;
	end: number;
}

export function getWordRanges(
	parts: Change[],
	isAdded: boolean,
): WordRange[] {
	const ranges: WordRange[] = [];
	let pos = 0;
	for (const part of parts) {
		if (isAdded) {
			if (part.removed) continue;
			if (part.added) {
				ranges.push({ start: pos, end: pos + part.value.length });
			}
			pos += part.value.length;
		} else {
			if (part.added) continue;
			if (part.removed) {
				ranges.push({ start: pos, end: pos + part.value.length });
			}
			pos += part.value.length;
		}
	}
	return ranges;
}

function sgrResetsBackground(parameters: string): boolean {
	const codes = parameters.split(";");
	for (let i = 0; i < codes.length; i++) {
		const code = Number(codes[i]!.split(":")[0]);
		if (code === 0 || code === 49) return true;
		if ((code === 38 || code === 48 || code === 58) && !codes[i]!.includes(":")) {
			// Extended-color components (including 0 and 49) are not SGR reset codes.
			const mode = Number(codes[++i]);
			if (mode === 2) i += 3;
			else if (mode === 5) i++;
		}
	}
	return false;
}

/**
 * Injects token-level word background escape codes into a syntax-highlighted line
 * without corrupting active foreground styling.
 */
export function applyIntraLineBg(
	highlightedLine: string,
	parts: Change[],
	isAdded: boolean,
	baseBg: string,
	wordBg: string,
): string {
	const ranges = getWordRanges(parts, isAdded);
	if (ranges.length === 0) return highlightedLine;

	let result = "";
	let visiblePos = 0;
	let inHighlight = false;
	let rangeIdx = 0;
	let j = 0;

	while (j < highlightedLine.length) {
		if (highlightedLine[j] === "\x1b") {
			const match = highlightedLine.slice(j).match(/^\x1b\[([0-9;:]*)m/);
			if (match) {
				result += match[0];
				if (sgrResetsBackground(match[1]!)) result += inHighlight ? wordBg : baseBg;
				j += match[0].length;
				continue;
			}
		}

		const inRange =
			rangeIdx < ranges.length &&
			visiblePos >= ranges[rangeIdx]!.start &&
			visiblePos < ranges[rangeIdx]!.end;

		if (inRange && !inHighlight) {
			result += wordBg;
			inHighlight = true;
		} else if (!inRange && inHighlight) {
			result += baseBg;
			inHighlight = false;
			if (rangeIdx < ranges.length && visiblePos >= ranges[rangeIdx]!.end) {
				rangeIdx++;
			}
		}

		result += highlightedLine[j];
		visiblePos++;
		j++;
	}

	if (inHighlight) {
		result += baseBg;
	}

	return result;
}

/**
 * Pair single removed line with single added line to perform intra-line word diffing.
 */
export function pairIntraLineDiffs(lines: DiffLine[]): void {
	let i = 0;
	while (i < lines.length) {
		if (lines[i]!.type === "removed") {
			const removedList: DiffLine[] = [];
			while (i < lines.length && lines[i]!.type === "removed") {
				removedList.push(lines[i]!);
				i++;
			}
			const addedList: DiffLine[] = [];
			while (i < lines.length && lines[i]!.type === "added") {
				addedList.push(lines[i]!);
				i++;
			}
			if (removedList.length === 1 && addedList.length === 1) {
				const parts = diffWords(
					removedList[0]!.cleanContent,
					addedList[0]!.cleanContent,
				);
				removedList[0]!.wordParts = parts;
				addedList[0]!.wordParts = parts;
			}
		} else {
			i++;
		}
	}
}

/**
 * Applies syntax highlighting to parsed diff lines using Pi's syntax highlighter.
 */
export function applySyntaxHighlighting(
	lines: DiffLine[],
	filePath?: string,
): void {
	let lang: string | undefined;
	if (filePath && typeof PiCodingAgent.getLanguageFromPath === "function") {
		try {
			lang = PiCodingAgent.getLanguageFromPath(filePath);
		} catch (error) {
			warnCompatibilityFallback("language detection API", error);
		}
	} else if (filePath) {
		warnCompatibilityFallback("language detection API");
	}
	for (const line of lines) {
		if (line.type === "ellipsis") continue;
		if (line.cleanContent.length === 0) {
			line.highlighted = "";
			continue;
		}
		if (lang && typeof PiCodingAgent.highlightCode === "function") {
			try {
				const [hl] = PiCodingAgent.highlightCode(line.cleanContent, lang);
				line.highlighted = hl ?? line.cleanContent;
			} catch (error) {
				warnCompatibilityFallback("syntax highlighting API", error);
				line.highlighted = line.cleanContent;
			}
		} else {
			if (lang) warnCompatibilityFallback("syntax highlighting API");
			line.highlighted = line.cleanContent;
		}
	}
}

/**
 * Renders Claude Code style diff lines from raw diff text.
 */
export function renderToolDiffLines(
	diffText: string,
	filePath: string,
	theme?: Theme | { name?: string },
	width?: number,
): string[] {
	const { lines, maxLineNum } = parseDiffText(diffText);
	if (lines.length === 0) return [];

	applySyntaxHighlighting(lines, filePath);
	pairIntraLineDiffs(lines);

	const colors = getDiffThemeColors(theme);
	const colorMode = resolveThemeColorMode(theme);
	const tokenFg = (role: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext" | "toolOutput", fallback: string) =>
		theme && "getFgAnsi" in theme && typeof theme.getFgAnsi === "function" ? theme.getFgAnsi(role) : fallback;
	const codeFg = tokenFg("toolOutput", FG_DEFAULT);
	const rawWidth = width ??
		(typeof process !== "undefined" && process.stdout?.columns ? process.stdout.columns : 80);
	if (!Number.isFinite(rawWidth) || rawWidth < 1) return [];
	const targetWidth = Math.floor(rawWidth);

	const maxNumWidth = Math.max(1, String(maxLineNum).length);
	const gutterWidth = maxNumWidth + 3; // "<num> <sign> "
	const availCodeWidth = Math.max(1, targetWidth - gutterWidth);

	const output: string[] = [];

	for (const line of lines) {
		const paddedNum =
			line.lineNum === undefined
				? " ".repeat(maxNumWidth)
				: String(line.lineNum).padStart(maxNumWidth, " ");

		if (line.type === "added" || line.type === "removed") {
			const isAdded = line.type === "added";
			const sign = isAdded ? "+" : "-";
			const baseBg = bgAnsi(isAdded ? colors.diffAddedBg : colors.diffRemovedBg, colorMode);
			const wordBg = bgAnsi(isAdded ? colors.diffAddedWord : colors.diffRemovedWord, colorMode);
			const gutterFg = isAdded
				? tokenFg("toolDiffAdded", fgAnsi(colors.diffAddedGutter, colorMode))
				: tokenFg("toolDiffRemoved", fgAnsi(colors.diffRemovedGutter, colorMode));
			const code = line.wordParts
				? applyIntraLineBg(line.highlighted, line.wordParts, isAdded, baseBg, wordBg)
				: line.highlighted;

			const wrapped =
				line.cleanContent.length > 0
					? wrapTextWithAnsi(baseBg + codeFg + code, availCodeWidth)
					: [""];

			for (let r = 0; r < wrapped.length; r++) {
				const g =
					r === 0
						? `${baseBg}${gutterFg}${paddedNum} ${sign} ${codeFg}`
						: `${baseBg}${" ".repeat(gutterWidth)}`;
				const row = g + wrapped[r]!;
				const pad = Math.max(0, targetWidth - visibleWidth(row));
				output.push(`${row}${baseBg}${" ".repeat(pad)}${RESET}`);
			}
		} else if (line.type === "context") {
			const gutterFg = tokenFg("toolDiffContext", fgAnsi(colors.diffContextGutter, colorMode));
			const wrapped =
				line.cleanContent.length > 0
					? wrapTextWithAnsi(codeFg + line.highlighted, availCodeWidth)
					: [""];

			for (let r = 0; r < wrapped.length; r++) {
				const g =
					r === 0
						? `${gutterFg}${paddedNum}   ${codeFg}`
						: " ".repeat(gutterWidth);
				output.push(g + wrapped[r]!);
			}
		} else {
			// ellipsis
			const gutterFg = tokenFg("toolDiffContext", fgAnsi(colors.diffContextGutter, colorMode));
			output.push(
				`${" ".repeat(gutterWidth)}${gutterFg}${line.cleanContent}${FG_DEFAULT}`,
			);
		}
	}

	return output.map((line) => PiTui.truncateToWidth(line, targetWidth, ""));
}

/** Pi TUI diff component with optional self-rendered horizontal padding. */
export class ToolDiffComponent {
	readonly diffText: string;
	readonly filePath: string;
	readonly theme?: Theme;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly paddingX: number;

	constructor(diffText: string, filePath: string, theme?: Theme, paddingX = 0) {
		this.diffText = diffText;
		this.filePath = filePath;
		this.theme = theme;
		this.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const pad = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		const margin = " ".repeat(pad);
		const lines = renderToolDiffLines(
			this.diffText,
			this.filePath,
			this.theme,
			width - pad * 2,
		).map((line) => margin + line + margin);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

// Preserve the existing symbol names for consumers migrating to tool-diff.ts.
export { ToolDiffComponent as ClaudeDiffComponent, renderToolDiffLines as renderClaudeDiffLines };
