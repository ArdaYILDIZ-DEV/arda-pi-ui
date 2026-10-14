import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	countChangedFiles,
	parsePullRequestJson,
	formatGitSummary,
	emptyGitInfoState,
	GitInfoController,
	registerGitInfo,
	type GitInfoState,
	type CommandRunnerFn,
} from "../git-info.ts";

describe("git-info pure helpers", () => {
	describe("countChangedFiles", () => {
		it("returns 0 for empty or invalid input", () => {
			assert.equal(countChangedFiles(""), 0);
			assert.equal(countChangedFiles("   \n\n  "), 0);
			assert.equal(countChangedFiles(null as any), 0);
			assert.equal(countChangedFiles(undefined as any), 0);
		});

		it("counts modified and untracked files accurately", () => {
			const output = " M src/index.ts\n?? new-file.txt\nD  deleted.ts\n";
			assert.equal(countChangedFiles(output), 3);
		});

		it("ignores blank lines in status output", () => {
			const output = "\n M foo.ts\n\n?? bar.ts\n\n";
			assert.equal(countChangedFiles(output), 2);
		});
	});

	describe("parsePullRequestJson", () => {
		it("parses valid open pull request JSON", () => {
			const raw = JSON.stringify({
				number: 42,
				url: "https://github.com/org/repo/pull/42",
				state: "OPEN",
				isDraft: false,
			});
			const pr = parsePullRequestJson(raw);
			assert.deepEqual(pr, {
				number: 42,
				url: "https://github.com/org/repo/pull/42",
				isDraft: false,
			});
		});

		it("returns null for non-OPEN PRs or malformed JSON", () => {
			assert.equal(
				parsePullRequestJson(
					JSON.stringify({ number: 42, url: "x", state: "MERGED" }),
				),
				null,
			);
			assert.equal(
				parsePullRequestJson(
					JSON.stringify({ number: 42, url: "x", state: "CLOSED" }),
				),
				null,
			);
			assert.equal(parsePullRequestJson("not-valid-json"), null);
			assert.equal(parsePullRequestJson(""), null);
			assert.equal(parsePullRequestJson(null as any), null);
		});
	});

	describe("formatGitSummary", () => {
		it("returns empty string for non-repositories", () => {
			assert.equal(formatGitSummary(emptyGitInfoState()), "");
			assert.equal(
				formatGitSummary({
					isRepository: false,
					branch: "main",
					changedFiles: 0,
					pullRequest: null,
				}),
				"",
			);
		});

		it("formats clean repository branch", () => {
			const state: GitInfoState = {
				isRepository: true,
				branch: "main",
				changedFiles: 0,
				pullRequest: null,
			};
			assert.equal(formatGitSummary(state), "main");
		});

		it("formats dirty repository with changed files in Turkish and English", () => {
			const state: GitInfoState = {
				isRepository: true,
				branch: "feature-ui",
				changedFiles: 3,
				pullRequest: null,
			};
			assert.equal(
				formatGitSummary(state, { language: "tr" }),
				"feature-ui* · 3 dosya",
			);
			assert.equal(
				formatGitSummary(state, { language: "en" }),
				"feature-ui* · 3 files",
			);
		});

		it("formats detached HEAD with hash", () => {
			const state: GitInfoState = {
				isRepository: true,
				branch: "detached@8c1fb7c",
				changedFiles: 1,
				pullRequest: null,
			};
			assert.equal(formatGitSummary(state), "detached@8c1fb7c* · 1 dosya");
		});

		it("includes PR information when available", () => {
			const state: GitInfoState = {
				isRepository: true,
				branch: "fix-bug",
				changedFiles: 2,
				pullRequest: {
					number: 105,
					url: "https://github.com/org/repo/pull/105",
				},
			};
			assert.equal(formatGitSummary(state), "fix-bug* · 2 dosya · PR #105");
			assert.equal(
				formatGitSummary(state, { includePr: false }),
				"fix-bug* · 2 dosya",
			);
		});
	});
});

describe("GitInfoController lifecycle & commands", () => {
	const status = (branch = "main", changes = "", oid = "abc1234abcdef") =>
		`# branch.oid ${oid}\0# branch.head ${branch}\0${changes}`;
	const changed = "1 .M N... 100644 100644 100644 abc abc index.ts\0? new.txt\0";
	const pr = (number = 99) => JSON.stringify({ number, url: "https://example.test/pr", state: "OPEN" });

	it("handles non-git directories gracefully", async (t) => {
		const controller = new GitInfoController(async () => ({ stdout: "", code: 128 }));
		t.after(() => controller.dispose());
		assert.deepEqual(await controller.refresh("/some/path"), emptyGitInfoState());
	});

	it("reads branch and changed files in one lock-free local command without GitHub access", async (t) => {
		const calls: { cmd: string; args: string[] }[] = [];
		const runner: CommandRunnerFn = async (cmd, args) => {
			calls.push({ cmd, args });
			return { stdout: status("develop", changed), code: 0 };
		};
		const controller = new GitInfoController(runner);
		t.after(() => controller.dispose());
		let notifications = 0;
		controller.addListener(() => notifications++);
		const state = await controller.refresh("/repo");
		assert.deepEqual(state, { isRepository: true, branch: "develop", changedFiles: 2, pullRequest: null });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "git");
		for (const flag of ["--no-optional-locks", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z"]) {
			assert.ok(calls[0].args.includes(flag), flag);
		}
		assert.equal(notifications, 1);
		await controller.refresh("/repo");
		assert.equal(notifications, 1, "unchanged state must not redraw the footer");
	});

	it("handles detached HEAD and unborn branches without extra commands", async (t) => {
		let output = status("(detached)");
		const controller = new GitInfoController(async () => ({ stdout: output, code: 0 }));
		t.after(() => controller.dispose());
		assert.equal((await controller.refresh("/repo")).branch, "detached@abc1234");
		output = status("new-branch", "", "(initial)");
		assert.equal((await controller.refresh("/repo")).branch, "new-branch");
	});

	it("counts renames, conflicts and newline-containing paths without counting rename sources", async (t) => {
		const output = status("main",
			"2 R. N... 100644 100644 100644 abc abc R100 destination\0? source\nname\0" +
			"? new\nfile\0u UU N... 100644 100644 100644 100644 abc abc abc conflict\0");
		const controller = new GitInfoController(async () => ({ stdout: output, code: 0 }));
		t.after(() => controller.dispose());
		assert.equal((await controller.refresh("/repo")).changedFiles, 3);
	});

	it("only queries PRs explicitly and invalidates cached PRs on repository or branch changes", async (t) => {
		const calls: string[] = [];
		let branch = "main";
		const controller = new GitInfoController(async (cmd, _args, cwd) => {
			if (cmd === "gh") {
				calls.push(cwd);
				return { stdout: pr(cwd === "/repo-a" ? 1 : 2), code: 0 };
			}
			return { stdout: status(branch), code: 0 };
		});
		t.after(() => controller.dispose());
		await controller.refresh("/repo-a");
		assert.deepEqual(calls, []);
		await controller.refresh("/repo-a", { refreshPr: true });
		await controller.refresh("/repo-a");
		assert.deepEqual(calls, ["/repo-a"]);
		assert.equal(controller.getState().pullRequest?.number, 1);
		await controller.refresh("/repo-b");
		assert.equal(controller.getState().pullRequest, null);
		await controller.refresh("/repo-b", { refreshPr: true });
		assert.equal(controller.getState().pullRequest?.number, 2);
		branch = "other";
		await controller.refresh("/repo-b");
		assert.equal(controller.getState().pullRequest, null);
		assert.deepEqual(calls, ["/repo-a", "/repo-b"]);
	});

	it("does not confuse a named detached-fix branch with detached HEAD, or erase Git data when gh fails", async (t) => {
		let queries = 0;
		const controller = new GitInfoController(async (cmd) => {
			if (cmd === "gh") { queries++; throw new Error("offline"); }
			return { stdout: status("detached-fix", changed), code: 0 };
		});
		t.after(() => controller.dispose());
		const state = await controller.refresh("/repo", { refreshPr: true });
		assert.equal(queries, 1);
		assert.equal(state.branch, "detached-fix");
		assert.equal(state.changedFiles, 2);
		controller.dispose();
	});

	it("preserves an explicit PR refresh requested during an in-flight update", async (t) => {
		let release!: () => void;
		let reached!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { reached = resolve; });
		let calls = 0;
		const controller = new GitInfoController(async (cmd) => {
			if (cmd === "gh") {
				calls++;
				if (calls === 1) { reached(); await gate; }
				return { stdout: "", code: 1 };
			}
			return { stdout: status(), code: 0 };
		});
		t.after(() => controller.dispose());
		const first = controller.refresh("/repo", { refreshPr: true });
		await started;
		let queuedSettled = false;
		const queued = controller.refresh("/repo", { refreshPr: true }).then((state) => {
			queuedSettled = true;
			return state;
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(queuedSettled, false, "queued refresh must await the actual inspection");
		} finally {
			release();
		}
		await first;
		await queued;
		assert.equal(calls, 2);
	});

	it("does not publish stale repository results when cwd changes during a refresh", async (t) => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const controller = new GitInfoController(async (_cmd, _args, cwd) => {
			if (cwd === "/old") await gate;
			return { stdout: status(cwd === "/old" ? "old" : "new"), code: 0 };
		});
		t.after(() => controller.dispose());
		const branches: string[] = [];
		controller.addListener((state) => branches.push(state.branch));
		const first = controller.refresh("/old");
		const second = controller.refresh("/new");
		release();
		await Promise.all([first, second]);
		assert.deepEqual(branches, ["new"]);
	});

	it("settles pending refreshes without publishing or starting more commands after disposal", async (t) => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let calls = 0;
		let notifications = 0;
		const controller = new GitInfoController(async () => {
			calls++;
			await gate;
			return { stdout: status(), code: 0 };
		});
		t.after(() => controller.dispose());
		controller.addListener(() => notifications++);
		const first = controller.refresh("/repo");
		const second = controller.refresh("/repo");
		try {
			controller.dispose();
		} finally {
			release();
		}
		await Promise.all([first, second]);
		await controller.refresh("/repo");
		assert.equal(calls, 1);
		assert.equal(notifications, 0);
	});

	it("does not spawn inspections for headless sessions or read-only builtin completions", async (t) => {
		const handlers = new Map<string, Function>();
		const controller = registerGitInfo({ on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand: () => {} } as any);
		t.after(() => controller.dispose());
		let calls = 0;
		controller.setRunner(async () => { calls++; return { stdout: "", code: 1 }; });
		try {
			for (const toolName of ["read", "grep", "find", "ls"]) {
				handlers.get("tool_execution_end")!({ toolName }, { cwd: "/repo", hasUI: true });
			}
			await handlers.get("session_start")!({}, { cwd: "/repo", hasUI: false });
			handlers.get("agent_settled")!({}, { cwd: "/repo", hasUI: false });
			handlers.get("tool_execution_end")!({ toolName: "edit" }, { cwd: "/repo", hasUI: false });
			assert.equal(calls, 0);
			handlers.get("tool_execution_end")!({ toolName: "edit" }, { cwd: "/repo", hasUI: true });
			assert.equal(calls, 1);
			handlers.get("session_shutdown")!({}, {});
		} finally {
			controller.dispose();
		}
	});

	it("registers /git and refreshes PR information only on /git refresh", async (t) => {
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		const controller = registerGitInfo({
			on: () => {},
			registerCommand: (name: string, opts: any) => { if (name === "git") handler = opts.handler; },
		} as any);
		t.after(() => controller.dispose());
		const notified: string[] = [];
		const ctx = { cwd: "/mock", ui: { notify: (msg: string) => notified.push(msg) } };
		controller.setRunner(async (cmd) => ({
			stdout: cmd === "gh" ? pr() : status("main", "1 .M N... 100644 100644 100644 abc abc a.ts\0"), code: 0,
		}));
		assert.ok(handler);
		await handler("refresh", ctx);
		assert.ok(notified.pop()?.includes("güncellendi"));
		await handler("", ctx);
		assert.ok(notified.pop()?.includes("main* · 1 dosya · PR #99"));
		controller.dispose();
	});
});
