/** Replace existing padding only; never widen host-rendered terminal lines. */
export function markPromptLine(line: string, dim = false): string {
	// These are host-rendered lines, not raw tool/user text. Keep SGR and OSC
	// (both BEL and ST terminated), including the host's cursor/zone markers.
	return line.replace(/^((?:\x1b\[[0-9;:]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))*) {2}/,
		(_match, escapes: string) => `${escapes}${dim ? "\x1b[2m❯\x1b[22m" : "❯"} `);
}

export function reportPromptError(feature: string, error: unknown): void {
	console.error(`[arda-pi-ui] ${feature} disabled; keeping Pi's default rendering.`, error);
}
