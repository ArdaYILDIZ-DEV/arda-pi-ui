/** Pi wordmark and falling-block choreography, reimplemented from pi-cc-header.
 * The upstream design credits pi.dev/install.sh; see THIRD_PARTY_NOTICES.md.
 * Rasterization is independent of ANSI, host state and timer ownership.
 */
export type HeaderLogoTone = "red" | "cyan" | "green" | "orange" | "white" | "logo";
export const HEADER_LOGO_WIDTH = 14;
export const HEADER_LOGO_LAST_FRAME = 21;
const ROWS = 6;
const COLUMNS = HEADER_LOGO_WIDTH / 2;
type Pixel = HeaderLogoTone | null;

/** Six visible rows of two-column pixels, matching the original Pi wordmark. */
export function buildHeaderLogo(
	frame: number,
	stripes: boolean,
	paint: (tone: HeaderLogoTone, glyph: string, row: number) => string,
): string[] {
	const step = Number.isFinite(frame) ? Math.max(0, Math.min(HEADER_LOGO_LAST_FRAME, Math.floor(frame))) : HEADER_LOGO_LAST_FRAME;
	const pixels: Pixel[][] = Array.from({ length: ROWS }, () => Array<Pixel>(COLUMNS).fill(null));
	const stamp = (shape: readonly string[], top: number, left: number, tone: HeaderLogoTone) => {
		for (let y = 0; y < shape.length; y++) {
			for (let x = 0; x < shape[y].length; x++) {
				const row = top + y;
				const column = left + x;
				if (shape[y][x] === "#" && row >= 0 && row < ROWS && column >= 0 && column < COLUMNS) {
					pixels[row][column] = tone;
				}
			}
		}
	};
	const assemble = (top: number, monochrome?: "white" | "logo") => {
		stamp(["###", "..#"], top, 1, monochrome ?? "cyan");
		stamp(["#.", "##", "#."], top + 1, 1, monochrome ?? "red");
		stamp(["#", "#"], top + 2, 4, monochrome ?? "green");
	};

	if (step < 16) {
		// The three falling tetrominoes settle on the orange base before rotation.
		stamp(["####"], 4, 0, "orange");
		if (step >= 4) stamp(["#.", "##", "#."], 1, 1, "red");
		if (step >= 7) stamp(["###", "..#"], 0, 1, "cyan");
		if (step >= 12) stamp(["#.", "#.", "##"], 2, 4, "green");
		if (step < 4) stamp(["#.", "##", "#."], step - 2, 1, "red");
		else if (step < 7) stamp(["###", "..#"], step - 6, 1, "cyan");
		else if (step < 12) stamp(["#.", "#.", "##"], step - 9, 4, "green");
		if (step === 13 || step === 15) stamp(["######"], 4, 0, "orange");
	} else {
		const tone = step === 18 || step === 20 ? "white" : step === HEADER_LOGO_LAST_FRAME ? "logo" : undefined;
		assemble(step === 16 ? 0 : 1, tone);
	}

	return pixels.map((row, y) => row.map((tone, x) => {
		if (tone !== null) return paint(tone, "██", y);
		if (stripes && step === HEADER_LOGO_LAST_FRAME && x < 6) return paint("logo", "──", y);
		return "  ";
	}).join(""));
}
