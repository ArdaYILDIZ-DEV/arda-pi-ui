import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { installCompactUserMessagePatch } from "../user-message.ts";

const start = "\x1b]133;A\x07";
const end = "\x1b]133;B\x07";
const final = "\x1b]133;C\x07";

describe("compact user messages", () => {
	it("compacts the real Pi component without changing content or styling", () => {
		initTheme();
		const proto = UserMessageComponent.prototype;
		const descriptor = Object.getOwnPropertyDescriptor(proto, "render")!;
		try {
			const component = new UserMessageComponent("hello **world**");
			const original = component.render(40);
			assert.ok(original.length >= 3);
			installCompactUserMessagePatch(proto);
			const compact = component.render(40);
			assert.equal(compact.length, original.length - 2);
			assert.equal(compact[0], start + original[1] + end + final);
		} finally {
			Object.defineProperty(proto, "render", descriptor);
		}
	});

	it("removes only outer padding and relocates each OSC 133 marker exactly once", () => {
		for (const body of [["message"], ["first", "", "last"]]) {
			const lines = [start + "top padding", ...body.map((line) => end + line + start + final + start), end + final + "bottom padding"];
			const proto = { render: (_width: number) => lines };
			installCompactUserMessagePatch(proto);
			const expected = [...body];
			expected[0] = start + expected[0];
			expected[expected.length - 1] += end + final;
			const result = proto.render(80);
			assert.deepEqual(result, expected);
			for (const marker of [start, end, final]) {
				assert.equal(result.join("\n").split(marker).length - 1, 1);
			}
			assert.equal(lines.length, body.length + 2, "original output is not mutated");
		}
	});

	it("returns outputs shorter than three lines unchanged, including identity and markers", () => {
		for (const lines of [[], [start + "one" + end + final], [start + "one", "two" + end + final]]) {
			const proto = { render: (_width: number) => lines };
			installCompactUserMessagePatch(proto);
			assert.equal(proto.render(80), lines);
		}
	});

	it("preserves receiver and width and does not stack after repeated installation or module reload", async () => {
		let calls = 0;
		const proto = {
			text: "message",
			render(width: number) {
				calls++;
				assert.equal(width, 42);
				return ["", this.text, "second", "third", ""];
			},
		};
		installCompactUserMessagePatch(proto);
		const render = proto.render;
		installCompactUserMessagePatch(proto);
		const modulePath = "../user-message.ts?reload-test";
		const reloaded = await import(modulePath);
		reloaded.installCompactUserMessagePatch(proto);
		assert.equal(proto.render, render);
		assert.deepEqual(proto.render(42), [start + "message", "second", "third" + end + final]);
		assert.equal(calls, 1);
	});
});
