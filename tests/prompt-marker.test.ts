import assert from "node:assert/strict";
import { it } from "node:test";
import { CustomEditor, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { wrapPromptEditor, registerPromptEditor } from "../prompt-editor.ts";
import { markPromptLine } from "../prompt-marker.ts";
import { installCompactUserMessagePatch } from "../user-message.ts";

it("places a dim prompt after leading SGR/OSC escapes without changing later lines", () => {
	const escapes = "\x1b[48;2;1;2;3m\x1b]8;;https://example.org\x1b\\";
	const proto = { render: (_width: number) => ["", escapes + "  hello", "  next", ""] };
	installCompactUserMessagePatch(proto);
	assert.deepEqual(proto.render(40), [
		"\x1b]133;A\x07" + escapes + "\x1b[2m❯\x1b[22m hello",
		"  next\x1b]133;B\x07\x1b]133;C\x07",
	]);
});

it("upgrades the old compact-only patch retained across reload without trimming again", () => {
	const render = (_width: number) => ["\x1b]133;A\x07  first", "  middle", "  last\x1b]133;B\x07\x1b]133;C\x07"];
	Object.defineProperty(render, Symbol.for("arda-pi-ui.compact-user-message-render"), { value: true });
	const proto = { render };
	installCompactUserMessagePatch(proto);
	const patched = proto.render;
	installCompactUserMessagePatch(proto);
	assert.equal(proto.render, patched);
	assert.deepEqual(proto.render(40), [
		"\x1b]133;A\x07\x1b[2m❯\x1b[22m first", "  middle", "  last\x1b]133;B\x07\x1b]133;C\x07",
	]);
});

it("preserves BEL OSC and colon SGR; leaves insufficient padding alone", () => {
	const prefix = "\x1b]133;A\x07\x1b[38:2::1:2:3m";
	assert.equal(markPromptLine(prefix + "  text"), prefix + "❯ text");
	assert.equal(markPromptLine(" text"), " text");
});

type Factory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
const args = [
	{ terminal: { rows: 40 }, requestRender() {} },
	{ borderColor: (s: string) => s, selectList: {} },
	{ matches: () => false },
] as unknown as Parameters<Factory>;

it("marks only the first real CustomEditor content line, empty or multiline, across renders", () => {
	for (const text of ["", "first\nsecond\nthird"]) {
		const editor = new CustomEditor(...args);
		editor.setText(text);
		wrapPromptEditor(editor);
		const render = editor.render;
		wrapPromptEditor(editor);
		assert.equal(editor.render, render);
		for (const width of [40, 80]) {
			editor.setPaddingX(0); // host appearance settings applied after factory
			const lines = editor.render(width);
			assert.ok(lines[1].startsWith("❯ "));
			assert.equal(lines.join("\n").split("❯").length - 1, 1);
			assert.equal(editor.getText(), text);
		}
		assert.ok(!editor.render(2).join("\n").includes("❯"), "narrow output is not widened");
	}
});

it("reuses the previous factory and does not stack across session_start or module reload", async () => {
	let handler: (event: unknown, ctx: ExtensionContext) => unknown = () => {};
	const pi = { on(_name: string, callback: typeof handler) { handler = callback; } } as unknown as ExtensionAPI;
	let creations = 0;
	let factory: Factory | undefined = (...parameters) => { creations++; return new CustomEditor(...parameters); };
	let sets = 0;
	const ctx = { hasUI: true, ui: {
		getEditorComponent: () => factory,
		setEditorComponent: (value: Factory) => { sets++; factory = value; },
	} } as unknown as ExtensionContext;
	registerPromptEditor(pi);
	handler({}, ctx);
	const wrapped = factory;
	handler({}, ctx);
	const modulePath = "../prompt-editor.ts?reload-test";
	const reloaded = await import(modulePath);
	reloaded.registerPromptEditor(pi);
	handler({}, ctx);
	assert.equal(factory, wrapped);
	assert.equal(sets, 1);
	assert.ok(factory!(...args).render(40)[1].startsWith("❯ "));
	assert.equal(creations, 1);
	handler({}, { hasUI: false } as ExtensionContext);
});

it("falls back to the original editor after a padding failure and logs only once", (t) => {
	const errors: unknown[][] = [];
	t.mock.method(console, "error", (...values: unknown[]) => { errors.push(values); });
	const editor = new CustomEditor(...args);
	editor.setText("hello");
	editor.setPaddingX(2);
	const original = editor.render(40);
	t.mock.method(editor, "setPaddingX", () => { throw new Error("padding unavailable"); });
	wrapPromptEditor(editor);
	for (let i = 0; i < 3; i++) assert.deepEqual(editor.render(40), original);
	assert.equal(errors.length, 1, "a render loop must not flood the log");
});

it("keeps the original user message after padding failure without disabling other instances", (t) => {
	const errors: unknown[][] = [];
	t.mock.method(console, "error", (...values: unknown[]) => { errors.push(values); });
	const lines = ["", "  hello", ""];
	const proto = {
		render: (_width: number) => lines,
		setOutputPad: (_padding: number): void => { throw new Error("padding unavailable"); },
	};
	installCompactUserMessagePatch(proto);
	for (let i = 0; i < 3; i++) assert.equal(proto.render(40), lines);
	const compatible = Object.create(proto) as typeof proto;
	compatible.setOutputPad = () => {};
	assert.ok(compatible.render(40)[0].includes("❯"));
	assert.equal(errors.length, 1, "failure is logged once per affected instance");
});

it("logs setup and patch failures without throwing or replacing default renderers", (t) => {
	const errors: unknown[][] = [];
	t.mock.method(console, "error", (...values: unknown[]) => { errors.push(values); });
	const proto = Object.freeze({ render: (_width: number) => ["", "  hello", ""] });
	assert.doesNotThrow(() => installCompactUserMessagePatch(proto));
	assert.deepEqual(proto.render(40), ["", "  hello", ""]);
	const editor = new CustomEditor(...args);
	const render = editor.render;
	Object.defineProperty(editor, "render", { value: render, writable: false });
	assert.doesNotThrow(() => wrapPromptEditor(editor));
	assert.equal(editor.render, render);
	let handler: (event: unknown, ctx: ExtensionContext) => unknown = () => {};
	registerPromptEditor({ on(_name: string, callback: typeof handler) { handler = callback; } } as unknown as ExtensionAPI);
	assert.doesNotThrow(() => handler({}, { hasUI: true, ui: {} } as ExtensionContext));
	assert.equal(errors.length, 3);
});
