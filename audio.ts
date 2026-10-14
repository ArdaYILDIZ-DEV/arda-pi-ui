/** Best-effort local audio playback; no processes start on import. */
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
			const res = childProcess.spawnSync(checkCmd, [candidate], { stdio: "ignore" });
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

		const proc = childProcess.spawn(player.cmd, args, {
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
