import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { buildHeaderLines, HeaderComponent, registerHeader } from "../header.ts";
import { DEFAULT_HEADER_CONFIG, parseHeaderConfig, readHeaderSettings } from "../header-settings.ts";
import { stripAnsi, visibleWidth } from "../palette.ts";
import { parseColor } from "@earendil-works/pi-tui";

const current = {
	color: "a", ver: 1, grad: true, lines: false, pkg: false, speed: 100,
	slogan: "Gurur duyacağın bir şey kodla.", sloganOn: true, sloganColor: true, disabled: false,
} as const;
const info = {
	version: "1.4.0", model: "test-model", thinking: "high", cwd: "/work/project",
	skills: 4, packageSkills: 2, prompts: 3, packages: 5,
};
const theme = {
	appearance: "dark", colors: { accent: parseColor("#3377CC"), muted: parseColor("#888888"), text: parseColor("#EEEEEE") },
	fg: (role: string, text: string) => `\x1b[${role === "muted" ? "90" : "36"}m${text}\x1b[39m`,
	getColorMode: () => "truecolor",
} as unknown as Theme;

function harness(config: unknown = current, commands: ReturnType<ExtensionAPI["getCommands"]> = []) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let component: HeaderComponent | undefined;
	let installs = 0;
	let renders = 0;
	const messages: string[] = [];
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
		getCommands: () => commands,
		getThinkingLevel: () => "high",
		registerCommand(_name: string, options: { handler: typeof command }) { command = options.handler; },
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui", hasUI: true, cwd: "/work/project", model: { id: "test-model" },
		ui: {
			theme,
			notify(message: string) { messages.push(message); },
			setHeader(factory: Parameters<ExtensionContext["ui"]["setHeader"]>[0]) {
				component?.dispose();
				installs++;
				component = factory?.({ requestRender() { renders++; } } as never, theme) as HeaderComponent;
			},
		},
	} as unknown as ExtensionContext;
	registerHeader(pi, { readSettings: () => ({ config: parseHeaderConfig(config), packages: 5, issues: [] }) });
	return {
		ctx, messages,
		emit: (reason = "startup") => handlers.get("session_start")?.({ type: "session_start", reason }, ctx),
		shutdown: () => handlers.get("session_shutdown")?.({}, ctx),
		command: (args: string) => command!(args, ctx),
		get component() { return component; }, get installs() { return installs; }, get renders() { return renders; },
	};
}

describe("header settings", () => {
	it("preserves the existing ccHeader settings without coercion", () => {
		assert.deepEqual(parseHeaderConfig(current), current);
		assert.deepEqual(parseHeaderConfig(null), DEFAULT_HEADER_CONFIG);
		assert.deepEqual(parseHeaderConfig([]), DEFAULT_HEADER_CONFIG);
		assert.deepEqual(parseHeaderConfig({ color: "__proto__", ver: 9, speed: NaN, grad: "false", slogan: "x".repeat(86) }), DEFAULT_HEADER_CONFIG);
		for (const color of ["a", "c", "r", "o", "y", "g", "w", "b", "p", "theme"]) {
			assert.equal(parseHeaderConfig({ color }).color, color);
		}
		for (const speed of [25, 50, 75, 100]) assert.equal(parseHeaderConfig({ speed }).speed, speed);
	});

	it("reads only the supplied settings and never repairs or rewrites malformed files", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "arda-header-"));
		const file = path.join(dir, "settings.json");
		try {
			assert.deepEqual(readHeaderSettings(file).config, DEFAULT_HEADER_CONFIG);
			await writeFile(file, JSON.stringify({ ccHeader: current, packages: ["npm:one", { source: "npm:two" }] }));
			assert.deepEqual(readHeaderSettings(file).config, current);
			assert.equal(readHeaderSettings(file).packages, 2);
			await writeFile(file, "{broken");
			assert.equal(readHeaderSettings(file).issues.length, 1);
			assert.equal(await readFile(file, "utf8"), "{broken");
			await writeFile(file, JSON.stringify({ ccHeader: { ver: -1, speed: 0 } }));
			assert.equal(readHeaderSettings(file).issues.length, 2);
			await writeFile(file, "[]");
			assert.equal(readHeaderSettings(file).issues.length, 1);
			assert.equal(readHeaderSettings(dir).issues.length, 1);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
});

describe("header rendering", () => {
	it("shows the current slogan, version, model and resource summary", () => {
		const lines = buildHeaderLines(current, info, 100, theme);
		const text = lines.map(stripAnsi).join("\n");
		assert.match(text, /Pi v1\.4\.0/);
		assert.match(text, /Gurur duyacağın bir şey kodla\./);
		assert.match(text, /test-model · high/);
		assert.match(text, /4 skills · 3 prompts · 5 packages/);
		assert.ok(!text.includes("pkg skills"));
		assert.deepEqual(buildHeaderLines({ ...current, disabled: true }, info, 100, theme), []);
	});

	it("renders the original pixel Pi wordmark, not a Greek pi symbol", () => {
		const lines = buildHeaderLines(current, info, 100, theme);
		assert.deepEqual(lines.map((line) => stripAnsi(line).slice(0, 14)), [
			"              ",
			"  ██████      ",
			"  ██  ██      ",
			"  ████  ██    ",
			"  ██    ██    ",
			"              ",
		]);
	});

	it("animates falling pieces, assembly, flashes and the final Pi wordmark", () => {
		const logo = (frame: number) => buildHeaderLines(current, info, 100, theme, frame).map((line) => stripAnsi(line).slice(0, 14));
		assert.notDeepEqual(logo(0), logo(1), "pieces must move, not just fade");
		assert.deepEqual(logo(3), logo(4), "the cyan piece starts above the visible area");
		assert.notDeepEqual(logo(4), logo(5));
		assert.notDeepEqual(logo(6), logo(7));
		assert.notEqual(buildHeaderLines(current, info, 100, theme, 12).join("\n"), buildHeaderLines(current, info, 100, theme, 13).join("\n"), "assembly flash recolors the already-filled base");
		assert.deepEqual(logo(18), logo(21), "white flash has the final Pi geometry");
		assert.notEqual(buildHeaderLines(current, info, 100, theme, 18).join("\n"), buildHeaderLines(current, info, 100, theme, 21).join("\n"));
		assert.deepEqual(logo(21), logo(100));
	});

	it("keeps version visible in all three color modes and switches every visual option", () => {
		const render = (patch: object) => buildHeaderLines({ ...current, ...patch }, info, 100, theme).join("\n");
		for (const ver of [0, 1, 2]) assert.match(stripAnsi(render({ ver })), /Pi v1\.4\.0/);
		assert.notEqual(render({ ver: 0 }), render({ ver: 1 }));
		assert.notEqual(render({ ver: 1 }), render({ ver: 2 }));
		for (const patch of [{ grad: false }, { lines: true }, { color: "b" }, { sloganColor: false }]) {
			assert.notEqual(render(patch), render({}));
		}
		assert.doesNotMatch(stripAnsi(render({ sloganOn: false })), /Gurur/);
		assert.match(stripAnsi(render({ pkg: true })), /4 skills \+ 2 pkg skills/);
	});

	it("fits narrow terminals and grapheme text without controls or newlines from data", () => {
		const unsafeInfo = { ...info, model: "model\x1b]52;c;secret\x07\nattack", cwd: "/x\x1b[2J/y\r\n" };
		const config = { ...current, slogan: "👨‍👩‍👧‍👦 e\u0301 世界\x1b[2J\nhello\x07" };
		for (const width of [1, 2, 5, 12, 18, 30, 50, 100]) {
			for (const line of buildHeaderLines(config, unsafeInfo, width, theme)) {
				assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
				assert.doesNotMatch(line, /\x1b\]|\x1b\[2J|[\r\n\x07]/);
			}
		}
		for (const width of [0, -1, NaN, Infinity]) assert.deepEqual(buildHeaderLines(current, info, width, theme), []);
	});

	it("uses active host theme colors and color encoding without trusting theme names", () => {
		const config = { ...current, color: "theme" } as const;
		const dark = buildHeaderLines(config, info, 100, theme).join("\n");
		const light = { ...theme, name: "dark-name", appearance: "light", colors: { ...theme.colors, accent: parseColor("#AA5599") }, getColorMode: () => "256color" } as unknown as Theme;
		const output = buildHeaderLines(config, info, 100, light).join("\n");
		assert.notEqual(output, dark);
		assert.match(output, /\x1b\[38;5;/);
		assert.doesNotMatch(output, /\x1b\[38;2;/);
	});
});

describe("header lifecycle", () => {
	it("animates once at the configured speed, then stops; shutdown and replacement cancel timers", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const h = harness();
		try {
			h.emit();
			t.mock.timers.tick(99);
			assert.equal(h.renders, 0);
			t.mock.timers.tick(1);
			assert.equal(h.renders, 1);
			for (let i = 0; i < 30; i++) t.mock.timers.tick(100);
			const settled = h.renders;
			assert.equal(settled, 21, "the original 22-frame sequence must play to completion");
			t.mock.timers.tick(10000);
			assert.equal(h.renders, settled);
			h.emit();
			h.component!.dispose();
			t.mock.timers.tick(1000);
			assert.equal(h.renders, settled);
			h.emit();
			h.shutdown();
			t.mock.timers.tick(1000);
			assert.equal(h.renders, settled);
		} finally { h.shutdown(); }
	});

	it("can replay the original animation after reload without changing settings", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const h = harness();
		try {
			h.emit("reload");
			const final = h.component!.render(100);
			await h.command("replay");
			assert.notDeepEqual(h.component!.render(100), final);
			for (let i = 0; i < 21; i++) t.mock.timers.tick(100);
			assert.equal(h.renders, 21);
			assert.deepEqual(h.component!.render(100), final);
		} finally { h.shutdown(); }
	});

	it("skips animation on reload/resume/fork and refreshes dynamic model and theme data", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const h = harness();
		try {
			for (const reason of ["reload", "resume", "fork"]) {
				h.emit(reason);
				t.mock.timers.tick(1000);
				assert.equal(h.renders, 0);
			}
			(h.ctx as { model: unknown }).model = { id: "new-model" };
			assert.match(h.component!.render(100).map(stripAnsi).join("\n"), /new-model/);
			const before = h.component!.render(100);
			(h.ctx.ui as { theme: Theme }).theme = { ...theme, getColorMode: () => "256color" } as Theme;
			assert.notDeepEqual(h.component!.render(100), before);
			assert.match(h.component!.render(100).join("\n"), /\x1b\[38;5;/);
		} finally { h.shutdown(); }
	});

	it("installs an empty header when disabled and never starts a timer in non-TUI modes", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const h = harness({ ...current, disabled: true });
		try {
			h.emit();
			assert.deepEqual(h.component!.render(100), []);
			t.mock.timers.tick(1000);
			assert.equal(h.renders, 0);
			for (const mode of ["rpc", "json", "print"]) {
				(h.ctx as { mode: string }).mode = mode;
				h.emit();
			}
			assert.equal(h.installs, 1);
		} finally { h.shutdown(); }
	});

	it("yields to a loaded pi-cc-header package regardless of handler order", () => {
		const h = harness(current, [{ name: "hc", source: "extension", sourceInfo: {
			path: "/agent/npm/node_modules/pi-cc-header/extensions/pi-cc-header.ts", source: "npm:pi-cc-header", origin: "package", scope: "user",
		} }]);
		try {
			h.emit();
			assert.equal(h.installs, 0);
			assert.match(h.messages.join(" "), /pi-cc-header/);
		} finally { h.shutdown(); }
	});

	it("counts registered resources by provenance rather than scanning installed packages", async () => {
		const resource = (name: string, source: "skill" | "prompt", origin: "package" | "top-level") => ({
			name, source, sourceInfo: { path: `/test/${name}`, source: "test", origin, scope: "user" as const },
		});
		const h = harness(current, [resource("local", "skill", "top-level"), resource("pkg", "skill", "package"), resource("prompt", "prompt", "package")]);
		try {
			h.emit("reload");
			assert.match(h.component!.render(100).map(stripAnsi).join("\n"), /1 skills · 1 prompts · 5 packages/);
			await h.command("pkg true");
			assert.match(h.component!.render(100).map(stripAnsi).join("\n"), /1 skills \+ 1 pkg skills/);
		} finally { h.shutdown(); }
	});

	it("cancels a still-pending entrance when a session replaces it or rendering fails", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const h = harness();
		try {
			h.emit();
			h.emit("reload");
			t.mock.timers.tick(1000);
			assert.equal(h.renders, 0);
		} finally { h.shutdown(); }
		let attempts = 0;
		const component = new HeaderComponent({
			config: current, info: () => info, theme: () => theme, animate: true,
			requestRender() { attempts++; throw new Error("disposed host"); },
		});
		try {
			t.mock.timers.tick(100);
			t.mock.timers.tick(10000);
			assert.equal(attempts, 1);
		} finally { component.dispose(); }
	});

	it("changes settings for the session only and can reload persisted settings", async () => {
		const h = harness();
		try {
			h.emit("reload");
			await h.command("off");
			assert.deepEqual(h.component!.render(100), []);
			await h.command("on");
			assert.ok(h.component!.render(100).length > 0);
			await h.command("slogan Yeni slogan");
			assert.match(h.component!.render(100).map(stripAnsi).join("\n"), /Yeni slogan/);
			await h.command("speed 0");
			assert.match(h.messages.at(-1)!, /Invalid/);
			await h.command("reload");
			assert.match(h.component!.render(100).map(stripAnsi).join("\n"), /Gurur/);
		} finally { h.shutdown(); }
	});
});
