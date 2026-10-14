/**
 * arda-pi-ui — Git repository information tracker for Pi.
 *
 * Lightweight, zero-dependency git status inspection using native Node.js child_process.
 * Queries current branch, detached HEAD, count of modified/untracked files,
 * and optional GitHub open Pull Request info via `gh pr view`.
 */
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeControlChars, stripAnsi } from "./palette.ts";
import { notifySafely } from "./pi-compat.ts";

export interface PullRequestInfo {
	readonly number: number;
	readonly url: string;
	readonly isDraft?: boolean;
}

export interface GitInfoState {
	readonly isRepository: boolean;
	readonly branch: string;
	readonly changedFiles: number;
	readonly pullRequest: PullRequestInfo | null;
}

export function emptyGitInfoState(): GitInfoState {
	return {
		isRepository: false,
		branch: "",
		changedFiles: 0,
		pullRequest: null,
	};
}

export const DEFAULT_GIT_TIMEOUT_MS = 2500;
export const DEFAULT_GH_TIMEOUT_MS = 5000;

/**
 * Pure helper to count changed / untracked files from `git status --porcelain=v1` output.
 */
export function countChangedFiles(statusOutput: string): number {
	if (!statusOutput || typeof statusOutput !== "string") return 0;
	const lines = statusOutput.split("\n");
	let count = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length > 0) {
			count++;
		}
	}
	return count;
}

/**
 * Parses JSON output from `gh pr view ... --json number,url,state,isDraft`.
 */
export function parsePullRequestJson(rawJson: string): PullRequestInfo | null {
	if (!rawJson || typeof rawJson !== "string") return null;
	try {
		const obj = JSON.parse(rawJson);
		if (
			typeof obj === "object" &&
			obj !== null &&
			typeof obj.number === "number" &&
			typeof obj.url === "string" &&
			obj.state === "OPEN"
		) {
			return {
				number: obj.number,
				url: obj.url,
				isDraft: Boolean(obj.isDraft),
			};
		}
	} catch {
		/* ignore JSON parse errors */
	}
	return null;
}

/**
 * Formats git information into a compact status string.
 * Examples:
 * - "main · 3 dosya" (or with PR: "main · 3 dosya · PR #12")
 * - "main" (clean)
 * - "detached@8c1fb7c · 1 dosya"
 */
export function formatGitSummary(
	info: GitInfoState,
	opts?: { includePr?: boolean; language?: "tr" | "en" },
): string {
	if (!info || !info.isRepository || !info.branch) {
		return "";
	}

	const lang = opts?.language ?? "tr";
	const includePr = opts?.includePr ?? true;

	const parts: string[] = [];
	const hasChanges = info.changedFiles > 0;
	const branchDisplay = hasChanges ? `${info.branch}*` : info.branch;
	parts.push(branchDisplay);

	if (hasChanges) {
		const fileWord =
			lang === "tr" ? "dosya" : info.changedFiles === 1 ? "file" : "files";
		parts.push(`${info.changedFiles} ${fileWord}`);
	}

	if (includePr && info.pullRequest) {
		parts.push(`PR #${info.pullRequest.number}`);
	}

	return parts.join(" · ");
}

export type CommandRunnerFn = (
	cmd: string,
	args: string[],
	cwd: string,
	timeoutMs?: number,
) => Promise<{ stdout: string; code: number }>;

/**
 * Native non-blocking command execution via child_process.execFile.
 */
export const defaultCommandRunner: CommandRunnerFn = (
	cmd: string,
	args: string[],
	cwd: string,
	timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS,
): Promise<{ stdout: string; code: number }> => {
	return new Promise((resolve) => {
		try {
			execFile(
				cmd,
				args,
				{
					cwd: cwd || process.cwd(),
					timeout: timeoutMs,
					maxBuffer: 1024 * 1024,
					windowsHide: true,
				},
				(error, stdout) => {
					if (error) {
						resolve({
							stdout: "",
							code: typeof error.code === "number" ? error.code : 1,
						});
					} else {
						resolve({ stdout: stdout.toString(), code: 0 });
					}
				},
			);
		} catch {
			resolve({ stdout: "", code: 1 });
		}
	});
};

/** Parse NUL-delimited porcelain v2; rename source paths are separate records. */
function parseStatus(output: string): GitInfoState {
	let branch = "";
	let oid = "";
	let changedFiles = 0;
	const records = output.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		if (record.startsWith("# branch.head ")) branch = record.slice(14);
		else if (record.startsWith("# branch.oid ")) oid = record.slice(13);
		else if (/^[12u?] /.test(record)) {
			changedFiles++;
			if (record.startsWith("2 ")) i++;
		}
	}
	if (!branch) return emptyGitInfoState();
	return {
		isRepository: true,
		branch: branch === "(detached)" ? `detached${/^[a-f0-9]+$/i.test(oid) ? `@${oid.slice(0, 7)}` : ""}` : branch,
		changedFiles,
		pullRequest: null,
	};
}

export class GitInfoController {
	private state: GitInfoState = emptyGitInfoState();
	private readonly listeners = new Set<(state: GitInfoState) => void>();
	private runner: CommandRunnerFn = defaultCommandRunner;
	private currentCwd = "";
	private stateCwd = "";
	private generation = 0;
	private disposed = false;
	private isRefreshing = false;
	private refreshPending = false;
	private refreshPrPending = false;
	private pendingRefreshWaiters: ((state: GitInfoState) => void)[] = [];

	constructor(runner?: CommandRunnerFn) {
		if (typeof runner === "function") this.runner = runner;
	}

	public getState(): GitInfoState {
		return this.state;
	}

	public setRunner(runner: CommandRunnerFn): void {
		this.runner = typeof runner === "function" ? runner : defaultCommandRunner;
	}

	public addListener(listener: (state: GitInfoState) => void): () => void {
		if (!this.disposed) this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private publish(state: GitInfoState): void {
		const old = this.state;
		this.state = state;
		if (old.isRepository === state.isRepository && old.branch === state.branch &&
			old.changedFiles === state.changedFiles && old.pullRequest?.number === state.pullRequest?.number &&
			old.pullRequest?.url === state.pullRequest?.url && old.pullRequest?.isDraft === state.pullRequest?.isDraft) return;
		for (const listener of this.listeners) {
			try {
				listener({ ...state });
			} catch {
				/* A listener must not prevent other UI subscribers from updating. */
			}
		}
	}

	public dispose(): void {
		this.disposed = true;
		this.generation++;
		this.listeners.clear();
		this.refreshPending = false;
		this.refreshPrPending = false;
		for (const resolve of this.pendingRefreshWaiters.splice(0)) resolve(this.state);
	}

	public async refresh(cwd?: string, options?: { refreshPr?: boolean }): Promise<GitInfoState> {
		if (this.disposed) return this.state;
		if (cwd && cwd !== this.currentCwd) {
			this.currentCwd = cwd;
			this.generation++;
		}
		const targetCwd = this.currentCwd || process.cwd();
		if (this.isRefreshing) {
			this.refreshPending = true;
			this.refreshPrPending ||= options?.refreshPr === true;
			return new Promise((resolve) => { this.pendingRefreshWaiters.push(resolve); });
		}

		const generation = this.generation;
		const isCurrent = () => !this.disposed && generation === this.generation;
		this.isRefreshing = true;
		try {
			// One atomic snapshot, no index locks and no ahead/behind traversal.
			const result = await this.runner("git", [
				"--no-optional-locks", "status", "--porcelain=v2", "--branch",
				"--untracked-files=all", "--no-ahead-behind", "-z",
			], targetCwd, DEFAULT_GIT_TIMEOUT_MS);
			if (!isCurrent()) return this.state;
			const next = result.code === 0 ? parseStatus(result.stdout) : emptyGitInfoState();
			const pullRequest = next.isRepository && targetCwd === this.stateCwd &&
				next.branch === this.state.branch && !options?.refreshPr ? this.state.pullRequest : null;
			this.stateCwd = targetCwd;
			this.publish({ ...next, pullRequest });

			// PR information is not used by the footer. Never contact GitHub merely
			// to render local status; /git refresh is the explicit network action.
			if (options?.refreshPr && next.isRepository && !result.stdout.split("\0").includes("# branch.head (detached)")) {
				try {
					const result = await this.runner("gh",
						["pr", "view", next.branch, "--json", "number,url,state,isDraft"],
						targetCwd, DEFAULT_GH_TIMEOUT_MS);
					if (isCurrent() && result.code === 0) {
						this.publish({ ...this.state, pullRequest: parsePullRequestJson(result.stdout) });
					}
				} catch {
					/* Missing/offline gh must not erase a valid local Git snapshot. */
				}
			}
		} catch {
			if (isCurrent()) this.publish(emptyGitInfoState());
		} finally {
			this.isRefreshing = false;
			if (this.refreshPending && !this.disposed) {
				const refreshPr = this.refreshPrPending;
				const waiters = this.pendingRefreshWaiters.splice(0);
				this.refreshPending = false;
				this.refreshPrPending = false;
				void this.refresh(this.currentCwd, { refreshPr }).then((state) => {
					for (const resolve of waiters) resolve(state);
				});
			}
		}
		return this.state;
	}
}

/**
 * Registers the Git Info extension with Pi ExtensionAPI.
 */
export function registerGitInfo(pi: ExtensionAPI): GitInfoController {
	const controller = new GitInfoController();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) void controller.refresh(ctx.cwd);
	});

	pi.on("session_shutdown", () => controller.dispose());

	pi.on("tool_execution_end", (event, ctx) => {
		// Known read-only builtins cannot change the repository; custom tools may.
		if (!ctx.hasUI || ["read", "grep", "find", "ls"].includes(event.toolName)) return;
		void controller.refresh(ctx?.cwd);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.hasUI) void controller.refresh(ctx.cwd);
	});

	pi.registerCommand("git", {
		description:
			"Git dalı ve değişiklik özetini gösterir (/git refresh ile tazeler)",
		handler: async (args, ctx) => {
			const clean = sanitizeControlChars(stripAnsi(args)).trim().toLowerCase();
			if (clean === "refresh" || clean === "tazele") {
				await controller.refresh(ctx?.cwd, { refreshPr: true });
				notifySafely(ctx, "Git bilgileri güncellendi.", "info");
				return;
			}

			const state = controller.getState();
			if (!state.isRepository) {
				notifySafely(ctx, "Mevcut dizin bir Git deposu değil.", "warning");
				return;
			}

			const summary = formatGitSummary(state, { includePr: true, language: "tr" });
			notifySafely(ctx, `Git: ${summary}`, "info");
		},
	});

	return controller;
}
