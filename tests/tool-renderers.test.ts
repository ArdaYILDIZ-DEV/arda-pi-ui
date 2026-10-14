import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import type { ExtensionAPI, Theme, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
	addAssistantResponseMarker,
	genericDetail,
	genericSummary,
	installGlobalClaudeToolPatch,
	isClaudeToolsEnabled,
	isGlobalClaudeToolPatchInstalled,
	prettyToolLabel,
	registerClaudeToolRenderers,
	registerToolRenderers,
	restoreBuiltinToolRenderers,
	setClaudeToolsEnabled,
	uninstallGlobalClaudeToolPatch,
} from "../tool-renderers.ts";
import { ToolDiffComponent } from "../tool-diff.ts";
import {
	ToolExecutionComponent,
	initTheme,
	createBashToolDefinition,
	createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";

try {
	initTheme();
} catch {
	/* best-effort: keyHint fallback rendering needs global theme */
}

function createMockTheme(): Theme {
	return {
		name: "test",
		fg: (_color: unknown, text: string) => text,
		bg: (_color: unknown, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

function createMockPi(builtinNames: string[] = []) {
	const registered: Array<{ name: string; def: unknown }> = [];
	const handlers: Record<string, Function[]> = {};
	const commands: Record<string, { handler: Function }> = {};
	const notifications: Array<{ message: string; type?: string }> = [];
	const pi = {
		handlers,
		commands,
		notifications,
		on(event: string, handler: Function) {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		},
		async emit(event: string, data: unknown, ctx: unknown) {
			for (const fn of handlers[event] ?? []) await fn(data, ctx);
		},
		registerCommand(name: string, options: { handler: Function }) {
			commands[name] = { handler: options.handler };
		},
		getAllTools() {
			return builtinNames.map((name) => ({
				name,
				description: `${name} tool`,
				parameters: {},
				sourceInfo: {
					path: `<builtin:${name}>`,
					source: "builtin",
					scope: "user",
					origin: "package",
				},
			}));
		},
		registerTool(def: { name: string }) {
			registered.push({ name: def.name, def });
		},
	} as unknown as ExtensionAPI & {
		handlers: Record<string, Function[]>;
		commands: Record<string, { handler: Function }>;
		notifications: Array<{ message: string; type?: string }>;
		emit: (e: string, d: unknown, c: unknown) => Promise<void>;
	};
	return { pi, registered, commands, notifications };
}

describe("tool-renderers pure helpers", () => {
	describe("prettyToolLabel", () => {
		it("maps known builtins to Claude labels", () => {
			assert.equal(prettyToolLabel("read"), "Read");
			assert.equal(prettyToolLabel("bash"), "Bash");
			assert.equal(prettyToolLabel("powershell"), "PowerShell");
			assert.equal(prettyToolLabel("edit"), "Edit");
			assert.equal(prettyToolLabel("write"), "Write");
			assert.equal(prettyToolLabel("grep"), "Grep");
			assert.equal(prettyToolLabel("find"), "Find");
			assert.equal(prettyToolLabel("ls"), "List");
		});

		it("prettifies custom tool names", () => {
			assert.equal(prettyToolLabel("ask_user_question"), "Ask User Question");
			assert.equal(prettyToolLabel("web-search"), "Web Search");
			assert.equal(prettyToolLabel("myTool"), "MyTool");
		});

		it("falls back to Tool for empty/invalid names", () => {
			assert.equal(prettyToolLabel(""), "Tool");
			assert.equal(prettyToolLabel(null as unknown as string), "Tool");
			assert.equal(prettyToolLabel(undefined as unknown as string), "Tool");
		});
	});

	describe("genericDetail", () => {
		it("prefers known keys over first string value", () => {
			assert.equal(genericDetail({ command: "ls -la", other: "x" }), "ls -la");
			assert.equal(
				genericDetail({ path: "/tmp/foo", command: "echo hi" }),
				"echo hi",
			);
			assert.equal(
				genericDetail({ question: "Devam edelim mi?" }),
				"Devam edelim mi?",
			);
			assert.equal(genericDetail({ pattern: "foo.*", path: "/tmp" }), "foo.*");
		});

		it("falls back to first string value", () => {
			assert.equal(genericDetail({ customArg: "hello" }), "hello");
		});

		it("returns empty string for non-objects", () => {
			assert.equal(genericDetail(null), "");
			assert.equal(genericDetail(undefined), "");
			assert.equal(genericDetail("cmd"), "");
			assert.equal(genericDetail({}), "");
			assert.equal(genericDetail({ n: 42 }), "");
		});
	});

	describe("genericSummary", () => {
		it("summarizes line counts", () => {
			assert.equal(genericSummary(""), "Done");
			assert.equal(genericSummary("one"), "Completed 1 line");
			assert.equal(genericSummary("a\nb\nc"), "Completed 3 lines");
		});
	});

	describe("addAssistantResponseMarker", () => {
		it("prefixes plain assistant text with dot", () => {
			assert.equal(addAssistantResponseMarker("hello"), "● hello");
		});

		it("leaves already-marked, empty, and block constructs untouched", () => {
			assert.equal(addAssistantResponseMarker("● hello"), "● hello");
			assert.equal(addAssistantResponseMarker("   "), "   ");
			assert.equal(addAssistantResponseMarker("# Title"), "# Title");
			assert.equal(addAssistantResponseMarker("- item"), "- item");
			assert.equal(addAssistantResponseMarker("```\ncode\n```"), "```\ncode\n```");
			assert.equal(addAssistantResponseMarker("> quote"), "> quote");
		});
	});
});

describe("registerClaudeToolRenderers (legacy builtin path)", () => {
	it("does not wrap a third-party builtin name before it is owned", () => {
		const { pi, registered } = createMockPi(["write"]);
		const entries = pi.getAllTools();
		pi.getAllTools = () => entries.map((entry) => ({
			...entry, sourceInfo: { ...entry.sourceInfo, source: "extension" },
		}));
		assert.deepEqual(registerClaudeToolRenderers(pi, "/tmp"), []);
		assert.equal(registered.length, 0);
	});

	it("preserves registration order and continues after an individual registration fails", () => {
		const { pi, registered } = createMockPi(["ls", "bash", "read"]);
		const register = pi.registerTool.bind(pi);
		pi.registerTool = (tool) => {
			if (tool.name === "read") throw new Error("mock registration failure");
			register(tool);
		};
		assert.deepEqual(registerClaudeToolRenderers(pi, "/tmp"), ["bash", "ls"]);
		assert.deepEqual(registered.map((entry) => entry.name), ["bash", "ls"]);
	});

	it("retains legacy call details and collapsed summaries for every builtin", () => {
		const cases = [
			["read", "Read", { path: "a.ts", offset: 10 }, "a.ts", "Read 2 lines"],
			["bash", "Bash", { command: "echo hi" }, "echo hi", "Returned 2 lines"],
			["powershell", "PowerShell", { command: "Write-Host hi" }, "Write-Host hi", "Returned 2 lines"],
			["edit", "Edit", { path: "a.ts" }, "a.ts", "Updated"],
			["write", "Write", { path: "a.ts" }, "a.ts", "Written"],
			["grep", "Grep", { pattern: "two words", path: "src" }, '"two words" in src', "Found 2 lines"],
			["find", "Find", { pattern: "*.ts" }, "*.ts", "Found 2 lines"],
			["ls", "List", {}, ".", "Listed 2 lines"],
		] as const;
		const { pi, registered } = createMockPi(cases.map(([name]) => name));
		assert.deepEqual(registerClaudeToolRenderers(pi, "/tmp"), cases.map(([name]) => name));
		const theme = createMockTheme();
		const context = { executionStarted: true, isError: false, isPartial: false };
		for (const [name, label, args, detail, summary] of cases) {
			const tool = registered.find((entry) => entry.name === name)!.def as ToolRenderers;
			const call = tool.renderCall!(args, theme, context as never).render(120).join("\n");
			assert.ok(call.includes(`${label}  ${detail}`), `${name}: ${call}`);
			assert.ok(!call.includes("offset:"));
			const output = tool.renderResult!({ content: [{ type: "text", text: "first\n\nlast" }], details: {} },
				{ expanded: false, isPartial: false }, theme, context as never).render(120).join("\n");
			assert.ok(output.includes(`Completed · ${summary}`), `${name}: ${output}`);
		}
	});

	it("delegates expanded reads and first-block images, but summarizes trailing images", () => {
		const { pi, registered } = createMockPi(["read"]);
		registerClaudeToolRenderers(pi, "/tmp");
		const tool = registered[0].def as ToolRenderers;
		const native = createReadToolDefinition("/tmp");
		const theme = createMockTheme();
		const context = { executionStarted: true, isError: false, isPartial: false, state: {}, showImages: false, args: { path: "a.png" } } as never;
		const image = { type: "image" as const, data: "", mimeType: "image/png" };
		const text = { type: "text" as const, text: "image note" };
		for (const [content, expanded] of [[[text], true], [[image, text], false]] as const) {
			const result = { content: [...content], details: undefined };
			const options = { expanded, isPartial: false };
			assert.deepEqual(tool.renderResult!(result, options, theme, context).render(80),
				native.renderResult!(result, options, theme, context).render(80));
		}
		const trailing = tool.renderResult!({ content: [text, image], details: {} },
			{ expanded: false, isPartial: false }, theme, context).render(80).join("\n");
		assert.ok(trailing.includes("Completed · Read 1 line"));
	});

	it("wraps all 8 builtins including powershell", () => {
		const { pi, registered } = createMockPi([
			"read",
			"bash",
			"powershell",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
		]);
		const wrapped = registerClaudeToolRenderers(pi, "/tmp");
		assert.deepEqual(wrapped.sort(), [
			"bash",
			"edit",
			"find",
			"grep",
			"ls",
			"powershell",
			"read",
			"write",
		]);
		assert.equal(registered.length, 8);
		for (const { def } of registered) {
			const d = def as {
				renderShell?: string;
				renderCall?: unknown;
				renderResult?: unknown;
			};
			assert.equal(d.renderShell, "self");
			assert.equal(typeof d.renderCall, "function");
			assert.equal(typeof d.renderResult, "function");
		}
	});

	it("skips non-builtin tools", () => {
		const { pi, registered } = createMockPi([]);
		// getAllTools returns only builtins; custom tools are not in the list
		// so nothing should be registered.
		const wrapped = registerClaudeToolRenderers(pi, "/tmp");
		assert.deepEqual(wrapped, []);
		assert.equal(registered.length, 0);
	});

	it("builtin renderers produce compact Claude output", () => {
		const { pi, registered } = createMockPi(["bash", "read"]);
		registerClaudeToolRenderers(pi, "/tmp");
		const theme = createMockTheme();
		const bash = registered.find((r) => r.name === "bash");
		assert.ok(bash);
		const bashDef = bash!.def as {
			renderCall: (args: unknown, theme: Theme, ctx: unknown) => Text;
			renderResult: (r: unknown, o: unknown, t: Theme, c: unknown) => Text;
		};
		const callComp = bashDef.renderCall({ command: "ls -la" }, theme, {
			executionStarted: true,
			isError: false,
			isPartial: false,
		});
		const callLines = callComp.render(80).join("\n");
		assert.ok(callLines.includes("Bash"));
		assert.ok(callLines.includes("ls -la"));

		const resultComp = bashDef.renderResult(
			{ content: [{ type: "text", text: "a\nb\n" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ executionStarted: true, isError: false, isPartial: false },
		);
		const resultLines = resultComp.render(80).join("\n");
		assert.ok(resultLines.includes("Returned 2 lines"));
	});

	it("edit renderer produces ClaudeDiffComponent when diff is present", () => {
		const { pi, registered } = createMockPi(["edit"]);
		registerClaudeToolRenderers(pi, "/tmp");
		const theme = createMockTheme();
		const edit = registered.find((r) => r.name === "edit");
		assert.ok(edit);
		const editDef = edit!.def as {
			renderCall: (args: unknown, theme: Theme, ctx: unknown) => Text;
			renderResult: (r: unknown, o: unknown, t: Theme, c: unknown) => unknown;
		};

		// renderCall produces Edit(path)
		const callComp = editDef.renderCall({ path: "src/server.ts" }, theme, {
			executionStarted: true,
			isError: false,
			isPartial: false,
		});
		assert.ok(callComp.render(80).join("\n").includes("Edit"));

		// renderResult with diff produces ClaudeDiffComponent directly
		const diffText = "+ 1 const x = 1;\n- 1 const x = 0;";
		const resultComp = editDef.renderResult(
			{
				content: [{ type: "text", text: "Successfully replaced" }],
				details: { diff: diffText },
			},
			{ expanded: false, isPartial: false },
			theme,
			{
				args: { path: "src/server.ts" },
				executionStarted: true,
				isError: false,
				isPartial: false,
			},
		) as { render: (width: number) => string[] };

		assert.ok(typeof resultComp.render === "function");
		const renderedLines = resultComp.render(80);
		assert.ok(renderedLines.length >= 2);
		assert.match(renderedLines[0]!, /1 \+ /);
		assert.match(renderedLines[1]!, /1 - /);

		// Error case renders error message in red
		const errorComp = editDef.renderResult(
			{ content: [{ type: "text", text: "File not found" }] },
			{ expanded: false, isPartial: false },
			theme,
			{
				args: { path: "src/server.ts" },
				executionStarted: true,
				isError: true,
				isPartial: false,
			},
		) as { render: (width: number) => string[] };
		assert.ok(errorComp.render(80).join("\n").includes("File not found"));
	});
});

describe("compact tool presentation", () => {
	function renderer(name: string, base?: ToolRenderers) {
		const { pi } = createMockPi();
		let resolver: ToolRendererResolver | undefined;
		pi.registerToolRenderer = (value) => { resolver = value; };
		registerToolRenderers(pi);
		return resolver!(name, () => base)!;
	}

	const theme = createMockTheme();
	const context = { executionStarted: true, isPartial: false, isError: false, outputPad: 1 };
	const result = { content: [{ type: "text" as const, text: "first\nlast" }], details: {} };
	const options = { expanded: false, isPartial: false };

	it("includes builtin scope and requested read bounds without inferring returned ranges", () => {
		const grep = renderer("grep").renderCall!({ pattern: "TODO", path: "src/", glob: "*.ts", limit: 20 }, theme, context as never).render(120).join("\n");
		assert.ok(grep.includes('"TODO" · src/ · glob: *.ts · limit: 20'));
		const read = renderer("read").renderCall!({ path: "a.ts", offset: 120, limit: 60 }, theme, context as never).render(120).join("\n");
		assert.ok(read.includes("a.ts · offset: 120 · limit: 60"));
		assert.ok(!read.includes("120–179"));
		assert.ok(renderer("ls").renderCall!({}, theme, context as never).render(80).join("\n").includes("List  ."));
		assert.ok(renderer("unknown").renderCall!({ query: "hello" }, theme, context as never).render(80).join("\n").includes("hello"));
	});

	it("labels pending states and completion with optional duration", () => {
		const tool = renderer("bash");
		assert.ok(tool.renderCall!({}, theme, { ...context, executionStarted: false, isPartial: true } as never).render(80).join("\n").includes("Preparing…"));
		assert.ok(tool.renderCall!({}, theme, { ...context, isPartial: true } as never).render(80).join("\n").includes("Working…"));
		const partial = tool.renderResult!(result, { ...options, isPartial: true }, theme, { ...context, isPartial: true, durationMs: 2100 } as never).render(80).join("\n");
		assert.ok(partial.includes("Working…"));
		assert.ok(!partial.includes("2.1s"));
		const complete = tool.renderResult!(result, options, theme, { ...context, durationMs: 2100 } as never).render(80).join("\n");
		assert.ok(complete.includes("Completed · Returned 2 lines · 2.1s"));
		const failed = tool.renderResult!(result, options, theme, { ...context, isError: true } as never).render(80).join("\n");
		assert.ok(failed.includes("Failed · first last"));
		assert.ok(!failed.includes("NaN"));
	});

	it("shows each supported incompleteness warning and full output location", () => {
		for (const details of [{ matchLimitReached: 20 }, { resultLimitReached: 20 }, { entryLimitReached: 20 }]) {
			const text = renderer("grep").renderResult!({ ...result, details }, options, theme, context as never).render(120).join("\n");
			assert.ok(text.includes("limit reached (20) · incomplete"));
		}
		const text = renderer("bash").renderResult!({ ...result, details: { truncation: { truncated: true }, linesTruncated: true, fullOutputPath: "/tmp/full.log" } }, options, theme, context as never).render(120).join("\n");
		assert.ok(text.includes("Output truncated"));
		assert.ok(text.includes("Lines truncated"));
		assert.ok(text.includes("Full output: /tmp/full.log"));
	});

	it("preserves the original expanded error renderer", () => {
		const original = new Text("rich error", 0, 0);
		const tool = renderer("custom", { renderResult: () => original });
		const expanded = tool.renderResult!(result, { ...options, expanded: true }, theme, { ...context, isError: true } as never);
		assert.ok(expanded instanceof Box);
		assert.equal(expanded.children[0], original);
		assert.notEqual(tool.renderResult!(result, options, theme, { ...context, isError: true } as never), original);
	});

	it("strips unsafe terminal controls from compact calls, warnings and fallback output", () => {
		const payload = "\x1b]52;c;YQ==\x07\x1b[2J\x90hidden\x9c";
		const tool = renderer("custom");
		const call = tool.renderCall!({ text: `before${payload}after` }, theme, context as never);
		const expandedCall = tool.renderCall!({ text: `before${payload}after` }, theme, { ...context, expanded: true } as never);
		const value = { content: [{ type: "text" as const, text: `before${payload}after\n\x1b[31msecond\x1b[39m` }], details: { fullOutputPath: `/tmp/${payload}output` } };
		for (const expanded of [false, true]) {
			const output = tool.renderResult!(value, { ...options, expanded }, theme, { ...context, isError: true } as never);
			for (const component of [call, expandedCall, output]) {
				const rows = component.render(160).join("\n");
				assert.ok(!rows.includes("52;c;") && !rows.includes("\x1b[2J") && !rows.includes("hidden"));
				assert.ok(rows.includes("beforeafter"));
			}
			if (expanded) assert.ok(output.render(160).join("\n").includes("\x1b[31msecond"));
		}
	});

	it("keeps all available error lines accessible in the expanded fallback", () => {
		const output = Array.from({ length: 45 }, (_, i) => `detail ${i + 1}`).join("\n");
		const text = renderer("custom").renderResult!({ content: [{ type: "text", text: output }], details: {} }, { ...options, expanded: true }, theme, { ...context, isError: true } as never).render(80).join("\n");
		assert.ok(text.includes("detail 45"));
		assert.ok(!text.includes("more lines"));
	});

	it("summarizes large diffs and exposes every diff line when expanded", () => {
		const diff = Array.from({ length: 20 }, (_, i) => `+${i + 1} unique_${i + 1}`).join("\n");
		const tool = renderer("edit");
		const value = { content: [], details: { diff } };
		const collapsed = tool.renderResult!(value, options, theme, context as never).render(80).join("\n");
		assert.ok(collapsed.includes("Updated · +20 / −0 lines"));
		assert.ok(collapsed.includes("to expand"));
		assert.ok(!collapsed.includes("unique_20"));
		const expanded = tool.renderResult!(value, { ...options, expanded: true }, theme, context as never).render(80).join("\n");
		assert.ok(expanded.includes("unique_20"));
	});

	it("uses our expanded edit diff even when native call and result renderers exist", () => {
		let nativeCalls = 0;
		const tool = renderer("edit", {
			renderCall() { nativeCalls++; return new Text("NATIVE_DIFF_PREVIEW", 0, 0); },
			renderResult() { nativeCalls++; return new Text("NATIVE_DIFF_RESULT", 0, 0); },
		});
		const ctx = { ...context, state: {}, expanded: true, args: { path: "src/example.ts" } };
		const call = tool.renderCall!(ctx.args, theme, ctx as never);
		assert.ok(call.render(80).join("\n").includes("Edit"));
		assert.ok(call.render(80).join("\n").includes("src/example.ts"));
		const diff = Array.from({ length: 20 }, (_, i) => `+${i + 1} unique_${i + 1}`).join("\n");
		const expanded = tool.renderResult!({ content: [], details: { diff } }, { ...options, expanded: true }, theme, ctx as never);
		assert.ok(expanded instanceof Container);
		assert.ok(expanded.children.some((child) => child instanceof ToolDiffComponent));
		assert.ok(expanded.render(80).join("\n").includes("unique_20"));
		assert.ok(expanded.render(80).join("\n").includes("Updated · +20 / −0 lines"));
		assert.equal(nativeCalls, 0);
	});

	it("still retains the original expanded edit error renderer without a native diff preview", () => {
		let nativeCalls = 0;
		const original = new Text("native error evidence", 0, 0);
		const tool = renderer("edit", {
			renderCall() { nativeCalls++; return new Text("native preview", 0, 0); },
			renderResult: () => original,
		});
		const ctx = { ...context, state: {}, expanded: true, isError: true, args: { path: "missing.ts" } };
		const call = tool.renderCall!(ctx.args, theme, ctx as never);
		assert.ok(call.render(80).join("\n").includes("Failed"));
		const expanded = tool.renderResult!(result, { ...options, expanded: true }, theme, ctx as never);
		assert.ok(expanded instanceof Box);
		assert.equal(expanded.children[0], original);
		assert.equal(nativeCalls, 0);
	});

	it("fits calls, warning rows and diff disclosures into narrow terminal widths", () => {
		const diff = Array.from({ length: 20 }, (_, i) => `+${i + 1} const value_${i} = true;`).join("\n");
		const components = [
			renderer("read").renderCall!({ path: "src/long-directory/tool-renderers.ts", offset: 120, limit: 60 }, theme, context as never),
			renderer("grep").renderResult!({ ...result, details: { matchLimitReached: 20 } }, options, theme, context as never),
			renderer("edit").renderResult!({ content: [], details: { diff } }, options, theme, context as never),
			renderer("edit").renderResult!({ content: [], details: { diff: "-1 old\n+1 new" } }, options, theme, context as never),
		];
		for (const width of [20, 40, 80, 120]) {
			for (const component of components) {
				const lines = component.render(width);
				assert.ok(lines.length > 0);
				assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width} columns`);
			}
		}
	});

	it("does not duplicate completion wording for generic tools", () => {
		const text = renderer("custom").renderResult!(result, options, theme, context as never).render(80).join("\n");
		assert.ok(text.includes("Completed 2 lines"));
		assert.ok(!text.includes("Completed · Completed"));
	});

	it("handles missing metadata and invalid durations without inventing status data", () => {
		const tool = renderer("bash");
		for (const durationMs of [undefined, NaN, Infinity, -1]) {
			const text = tool.renderResult!({ content: [], details: null }, options, theme, { ...context, durationMs } as never).render(80).join("\n");
			assert.ok(text.includes("Completed"));
			assert.ok(!text.includes("NaN") && !text.includes("Infinity") && !text.includes("-0.0s"));
			assert.ok(!text.includes("to expand") && !text.includes("incomplete"));
		}
		const malformed = tool.renderResult!({ ...result, details: { matchLimitReached: -1, truncation: null, fullOutputPath: 4 } }, options, theme, context as never).render(80).join("\n");
		assert.ok(!malformed.includes("incomplete") && !malformed.includes("Full output:"));
	});

	it("preserves full builtin arguments when the original expanded call renderer exists", () => {
		const original = new Text("full arguments", 0, 0);
		const expanded = renderer("grep", { renderCall: () => original }).renderCall!({ pattern: "TODO", path: "src/" }, theme, { ...context, expanded: true } as never);
		assert.ok(expanded instanceof Container);
		assert.ok(expanded.render(80).join("\n").includes("Grep"));
		assert.ok(expanded.children[1] instanceof Box);
		assert.equal(expanded.children[1].children[0], original);
		for (const name of ["bash", "powershell", "write", "edit", "find"]) {
			const args = name === "bash" || name === "powershell" ? { command: "echo test" }
				: name === "find" ? { pattern: "*.ts", path: "src/" } : { path: "src/a.ts" };
			const text = renderer(name).renderCall!(args, theme, context as never).render(120).join("\n");
			assert.ok(text.includes(name === "bash" || name === "powershell" ? "echo test" : "src/"));
		}
	});

	it("keeps expanded shell identity and full multiline commands with or without a base renderer", () => {
		const command = `echo ${"x".repeat(160)}\necho FINAL_COMMAND_LINE`;
		for (const name of ["bash", "powershell"]) {
			for (const base of [undefined, { renderCall: () => new Text(command, 0, 0) }]) {
				const tool = renderer(name, base);
				const expanded = tool.renderCall!({ command }, theme, { ...context, expanded: true } as never).render(240).join("\n");
				assert.ok(expanded.includes(name === "bash" ? "Bash" : "PowerShell"));
				assert.ok(expanded.includes("FINAL_COMMAND_LINE"));
				assert.ok(expanded.includes("Completed"));
			}
		}
	});

	it("isolates original call/result caches from compact components and from other executions", () => {
		const call = new Text("original call", 0, 0);
		const resultComponent = new Container();
		resultComponent.addChild(new Text("original output", 0, 0));
		const callPrevious: unknown[] = [];
		const resultPrevious: unknown[] = [];
		const tool = renderer("bash", {
			renderCall(_args, _theme, ctx) { callPrevious.push(ctx.lastComponent); return call; },
			renderResult(_result, _options, _theme, ctx) { resultPrevious.push(ctx.lastComponent); return resultComponent; },
		});
		const state = {};
		let lastCall;
		let lastResult;
		for (const expanded of [false, true, false, true]) {
			lastCall = tool.renderCall!({ command: "echo test" }, theme, { ...context, state, expanded, lastComponent: lastCall } as never);
			lastResult = tool.renderResult!(result, { ...options, expanded }, theme, { ...context, state, expanded, lastComponent: lastResult } as never);
		}
		tool.renderCall!({}, theme, { ...context, state: {}, expanded: true } as never);
		tool.renderResult!(result, { ...options, expanded: true }, theme, { ...context, state: {}, expanded: true } as never);
		assert.deepEqual(callPrevious, [undefined, call, undefined]);
		assert.deepEqual(resultPrevious, [undefined, resultComponent, resultComponent, undefined]);
	});

	it("supports actual Pi shell renderers across expand/collapse with consistent padding", () => {
		const tool = renderer("bash", createBashToolDefinition(process.cwd()) as ToolRenderers);
		const state = {};
		let lastCall;
		let lastResult;
		for (const expanded of [false, true, false, true]) {
			const ctx = { ...context, state, expanded, outputPad: 4, durationMs: 2100, args: { command: "echo test" }, invalidate() {}, showImages: false };
			lastCall = tool.renderCall!(ctx.args, theme, { ...ctx, lastComponent: lastCall } as never);
			lastResult = tool.renderResult!(result, { ...options, expanded }, theme, { ...ctx, lastComponent: lastResult } as never);
			const callRows = lastCall.render(80);
			assert.ok(callRows[0].startsWith("    ●"));
			assert.ok(callRows[0].includes("Bash"));
			for (const row of lastResult.render(80).filter((line) => line.trim())) assert.ok(row.startsWith("    "));
			if (expanded) assert.ok(lastResult.render(80).join("\n").includes("Took"));
		}
	});

	it("finalizes a previously expanded native renderer even when the final result is collapsed", () => {
		const phases: boolean[] = [];
		const tool = renderer("custom", {
			renderResult(_result, options) { phases.push(options.isPartial); return new Text("native result", 0, 0); },
		});
		const state = {};
		tool.renderResult!(result, { expanded: true, isPartial: true }, theme, { ...context, state, isPartial: true } as never);
		tool.renderResult!(result, options, theme, { ...context, state } as never);
		assert.deepEqual(phases, [true, false]);
	});

	it("does not double-pad self-rendered originals", () => {
		const call = new Text("self call", 4, 0);
		const output = new Text("self output", 4, 0);
		const tool = renderer("custom", { renderShell: "self", renderCall: () => call, renderResult: () => output });
		const expanded = tool.renderCall!({}, theme, { ...context, expanded: true, outputPad: 4 } as never);
		assert.ok(expanded instanceof Container);
		assert.equal(expanded.children[1], call);
		assert.equal(tool.renderResult!(result, { ...options, expanded: true }, theme, context as never), output);
	});

	it("keeps small diff previews and does not show success diffs for failed or partial results", () => {
		const value = { content: [{ type: "text" as const, text: "failure evidence" }], details: { diff: "-1 old\n+1 new" } };
		const tool = renderer("edit");
		assert.ok(tool.renderResult!(value, options, theme, context as never).render(80).join("\n").includes("new"));
		for (const state of [{ ...context, isError: true }, { ...context, isPartial: true }]) {
			const text = tool.renderResult!(value, { ...options, isPartial: state.isPartial }, theme, state as never).render(80).join("\n");
			assert.ok(!text.includes("+1 / −1"));
		}
	});
});

describe("Pi 1.x public renderer resolver", () => {
	afterEach(() => { uninstallGlobalClaudeToolPatch(); });

	it("renders builtin and custom tools without re-registering execution or patching the host", async () => {
		const { pi, registered } = createMockPi(["edit", "bash"]);
		let resolver: ToolRendererResolver | undefined;
		pi.registerToolRenderer = (value) => { resolver = value; };
		const prototype = ToolExecutionComponent.prototype as unknown as Record<string, unknown>;
		const original = prototype.getCallRenderer;
		registerToolRenderers(pi);
		await pi.emit("session_start", {}, { mode: "tui", cwd: "/tmp", hasUI: true });
		assert.ok(resolver);
		assert.equal(registered.length, 0);
		assert.equal(prototype.getCallRenderer, original);
		assert.equal(isGlobalClaudeToolPatchInstalled(), false);
		const theme = createMockTheme();
		const context = { executionStarted: true, isError: false, isPartial: false } as never;
		const bash = resolver("bash", () => undefined)!;
		assert.ok(bash.renderCall!({ command: "echo test" }, theme, context).render(80).join("\n").includes("Bash"));
		assert.ok(bash.renderResult!({ content: [{ type: "text", text: "a\nb" }], details: {} }, { expanded: false, isPartial: false }, theme, context).render(80).join("\n").includes("Returned 2 lines"));
		const custom = resolver("web_search", () => undefined)!;
		assert.ok(custom.renderCall!({ query: "test" }, theme, context).render(80).join("\n").includes("Web Search"));
		const edit = resolver("edit", () => undefined)!;
		const diff = edit.renderResult!({ content: [], details: { diff: "-1 old\n+1 new" } }, { expanded: false, isPartial: false }, theme, context);
		assert.ok(diff.render(80).join("\n").includes("new"));
	});

	it("removes its own legacy patch when reloading into the public resolver path", () => {
		const prototype = ToolExecutionComponent.prototype as unknown as Record<string, unknown>;
		const original = prototype.getCallRenderer;
		assert.equal(installGlobalClaudeToolPatch(), true);
		const { pi } = createMockPi();
		pi.registerToolRenderer = () => {};
		registerToolRenderers(pi);
		assert.equal(isGlobalClaudeToolPatchInstalled(), false);
		assert.equal(prototype.getCallRenderer, original);
	});

	it("honors Pi 1.1 outputPad for compact calls, results and edit diffs", () => {
		const { pi } = createMockPi();
		let resolver: ToolRendererResolver | undefined;
		pi.registerToolRenderer = (value) => { resolver = value; };
		registerToolRenderers(pi);
		const context = { executionStarted: true, outputPad: 4 } as never;
		const theme = createMockTheme();
		const bash = resolver!("bash", () => undefined)!;
		assert.ok(bash.renderCall!({ command: "echo test" }, theme, context).render(80)[0].startsWith("    ●"));
		assert.ok(bash.renderResult!({ content: [{ type: "text", text: "done" }], details: {} }, { expanded: false, isPartial: false }, theme, context).render(80)[0].startsWith("      └"));
		const edit = resolver!("edit", () => undefined)!;
		const diff = edit.renderResult!({ content: [], details: { diff: "+1 new" } }, { expanded: false, isPartial: false }, theme, context);
		assert.ok(diff.render(80)[0].startsWith("    "));
	});

	it("preserves expanded custom views, images, and the next resolver when disabled", () => {
		const { pi, registered } = createMockPi();
		let resolver: ToolRendererResolver | undefined;
		pi.registerToolRenderer = (value) => { resolver = value; };
		registerToolRenderers(pi);
		const call = new Text("rich call", 0, 0);
		const result = new Text("rich result", 0, 0);
		const base: ToolRenderers = { renderShell: "default", renderCall: () => call, renderResult: () => result };
		const wrapped = resolver!("custom", () => base)!;
		const theme = createMockTheme();
		const expandedCall = wrapped.renderCall!({}, theme, { expanded: true } as never);
		assert.ok(expandedCall instanceof Container);
		assert.ok(expandedCall.render(80).join("\n").includes("Custom"));
		assert.ok(expandedCall.children[1] instanceof Box);
		assert.equal(expandedCall.children[1].children[0], call);
		const expandedResult = wrapped.renderResult!({ content: [], details: {} }, { expanded: true, isPartial: false }, theme, {} as never);
		assert.ok(expandedResult instanceof Box);
		assert.equal(expandedResult.children[0], result);
		const imageResult = wrapped.renderResult!({ content: [{ type: "image", data: "", mimeType: "image/png" }], details: {} }, { expanded: false, isPartial: false }, theme, {} as never);
		assert.ok(imageResult instanceof Box);
		assert.equal(imageResult.children[0], result);
		setClaudeToolsEnabled(pi, false, "/tmp");
		assert.equal(resolver!("custom", () => base), base);
		assert.equal(registered.length, 0);
		setClaudeToolsEnabled(pi, true, "/tmp");
		assert.equal(registered.length, 0);
	});
});

describe("global patch (generic tools)", () => {
	afterEach(() => {
		try {
			uninstallGlobalClaudeToolPatch();
		} catch {
			/* ignore */
		}
	});

	it("installs idempotently and reports status", () => {
		assert.equal(installGlobalClaudeToolPatch(), true);
		assert.equal(isGlobalClaudeToolPatchInstalled(), true);
		assert.equal(installGlobalClaudeToolPatch(), true);
		assert.equal(uninstallGlobalClaudeToolPatch(), true);
		assert.equal(isGlobalClaudeToolPatchInstalled(), false);
	});

	it("forces self shell and generic renderers for custom tools", () => {
		installGlobalClaudeToolPatch();
		const comp = new ToolExecutionComponent(
			"ask_user_question",
			"test-id-1",
			{ question: "Devam edelim mi?", options: [] },
			{},
			undefined,
			{ requestRender: () => {} } as never,
			"/tmp",
		);
		const anyComp = comp as unknown as {
			getRenderShell: () => string;
			getCallRenderer: () =>
				| ((a: unknown, t: Theme, c: unknown) => Text)
				| undefined;
			getResultRenderer: () =>
				| ((r: unknown, o: unknown, t: Theme, c: unknown) => Text)
				| undefined;
		};
		assert.equal(anyComp.getRenderShell(), "self");

		const theme = createMockTheme();
		const callRenderer = anyComp.getCallRenderer();
		assert.equal(typeof callRenderer, "function");
		const callText = callRenderer!({ question: "Devam edelim mi?" }, theme, {
			executionStarted: true,
			isError: false,
			isPartial: false,
			expanded: false,
		});
		const callLines = callText.render(100).join("\n");
		assert.ok(callLines.includes("Ask User Question"));
		assert.ok(callLines.includes("Devam edelim mi?"));

		const resultRenderer = anyComp.getResultRenderer();
		assert.equal(typeof resultRenderer, "function");
		const resultText = resultRenderer!(
			{ content: [{ type: "text", text: "line1\nline2\n" }] },
			{ expanded: false, isPartial: false },
			theme,
			{
				executionStarted: true,
				isError: false,
				isPartial: false,
				expanded: false,
			},
		);
		const resultLines = resultText.render(100).join("\n");
		assert.ok(resultLines.includes("Completed 2 lines"));
	});

	it("leaves known builtins to the official path", () => {
		installGlobalClaudeToolPatch();
		const comp = new ToolExecutionComponent(
			"bash",
			"test-id-2",
			{ command: "echo hi" },
			{},
			undefined,
			{ requestRender: () => {} } as never,
			"/tmp",
		);
		const anyComp = comp as unknown as {
			getCallRenderer: () => unknown;
		};
		// Should delegate to the original builtin renderer, not our wrapper.
		const renderer = anyComp.getCallRenderer() as
			| { __ccUiClaudeWrapped?: boolean }
			| undefined;
		assert.equal(renderer?.__ccUiClaudeWrapped, undefined);
	});

	it("registerToolRenderers wires session_start without throwing in non-tui mode", async () => {
		const { pi } = createMockPi(["bash"]);
		registerToolRenderers(pi);
		assert.ok(Array.isArray(pi.handlers["session_start"]));
		// Non-TUI sessions must be ignored.
		await pi.emit(
			"session_start",
			{ type: "session_start" },
			{
				mode: "print",
				cwd: "/tmp",
				hasUI: false,
				ui: { theme: createMockTheme() },
			},
		);
		// TUI session registers builtin overrides (best-effort, must not throw).
		await pi.emit(
			"session_start",
			{ type: "session_start" },
			{
				mode: "tui",
				cwd: "/tmp",
				hasUI: true,
				ui: { theme: createMockTheme() },
			},
		);
		assert.equal(isGlobalClaudeToolPatchInstalled(), true);
	});
});

describe("dynamic toggle (/arda-tools)", () => {
	afterEach(() => {
		try {
			uninstallGlobalClaudeToolPatch();
		} catch {
			/* ignore */
		}
	});

	it("is enabled by default", () => {
		assert.equal(isClaudeToolsEnabled(), true);
	});

	it("disable restores plain builtin definitions and removes the patch", () => {
		const { pi, registered } = createMockPi(["read", "bash"]);
		const restored = setClaudeToolsEnabled(pi, false, "/tmp");
		assert.equal(isClaudeToolsEnabled(), false);
		assert.deepEqual(restored.sort(), ["bash", "read"]);
		assert.equal(isGlobalClaudeToolPatchInstalled(), false);
		// Restored definitions are the plain factories (no Claude self frame).
		for (const { def } of registered) {
			const d = def as { renderShell?: string };
			assert.notEqual(d.renderShell, "self");
		}
		// Direct restore is idempotent.
		const again = restoreBuiltinToolRenderers(pi, "/tmp");
		assert.deepEqual(again.sort(), ["bash", "read"]);
		// Re-enable brings the compact renderers back: registry source is our
		// own extension by now, still wrappable via remembered names.
		const wrapped = setClaudeToolsEnabled(pi, true, "/tmp");
		assert.equal(isClaudeToolsEnabled(), true);
		assert.deepEqual(wrapped.sort(), ["bash", "read"]);
		assert.equal(isGlobalClaudeToolPatchInstalled(), true);
	});

	it("arda-tools toggles state and notifies without registering the retired alias", async () => {
		const { pi, commands, notifications } = createMockPi(["bash"]);
		setClaudeToolsEnabled(pi, true, "/tmp");
		registerToolRenderers(pi);
		const cmd = commands["arda-tools"];
		assert.ok(cmd);
		assert.ok(!Object.hasOwn(commands, "cc-tools"));
		const ctx = {
			cwd: "/tmp",
			ui: {
				theme: createMockTheme(),
				notify: (message: string, type?: string) => {
					notifications.push({ message, type });
				},
			},
		};
		await cmd.handler("off", ctx);
		assert.equal(isClaudeToolsEnabled(), false);
		assert.ok(
			notifications[notifications.length - 1]?.message.includes("kapalı"),
		);
		await cmd.handler("", ctx);
		assert.ok(
			notifications[notifications.length - 1]?.message.includes("kapalı"),
		);
		await cmd.handler("toggle", ctx);
		assert.equal(isClaudeToolsEnabled(), true);
		assert.ok(notifications[notifications.length - 1]?.message.includes("açık"));
		await cmd.handler("on", ctx);
		assert.equal(isClaudeToolsEnabled(), true);
		setClaudeToolsEnabled(pi, true, "/tmp");
	});

	it("session_start respects the disabled switch", async () => {
		const { pi, registered } = createMockPi(["bash"]);
		registerToolRenderers(pi);
		setClaudeToolsEnabled(pi, false, "/tmp");
		const before = registered.length;
		await pi.emit(
			"session_start",
			{ type: "session_start" },
			{
				mode: "tui",
				cwd: "/tmp",
				hasUI: true,
				ui: { theme: createMockTheme() },
			},
		);
		assert.equal(isClaudeToolsEnabled(), false);
		assert.equal(isGlobalClaudeToolPatchInstalled(), false);
		// Disabled session re-registers plain definitions, never compact ones.
		for (const { def } of registered.slice(before)) {
			const d = def as { renderShell?: string };
			assert.notEqual(d.renderShell, "self");
		}
		setClaudeToolsEnabled(pi, true, "/tmp");
	});
});
