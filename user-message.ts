const OSC133_START = "\x1b]133;A\x07";
const OSC133_END = "\x1b]133;B\x07\x1b]133;C\x07";
const COMPACT_RENDER = Symbol.for("arda-pi-ui.compact-user-message-render");

interface UserMessageRenderer {
	render(width: number): string[];
}

/** Pi exposes horizontal outputPad, but no user-message vertical padding hook. */
export function installCompactUserMessagePatch(proto: UserMessageRenderer): void {
	const original = proto.render;
	if (typeof original !== "function") {
		throw new TypeError("UserMessageComponent.render is unavailable");
	}
	// Keep the marker on the replacement function, shared across extension reloads.
	if (Reflect.get(original, COMPACT_RENDER)) return;

	function render(this: UserMessageRenderer, width: number): string[] {
		const lines = original.call(this, width);
		if (lines.length < 3) return lines;

		// Remove only Pi's prompt-zone markers, not styling or other terminal data.
		const body = lines.slice(1, -1).map((line) =>
			line.replace(/\x1b\]133;[ABC](?:\x07|\x1b\\)/g, ""),
		);
		body[0] = OSC133_START + body[0];
		body[body.length - 1] += OSC133_END;
		return body;
	}

	// Prepare everything before the single prototype write so failure leaves it intact.
	Object.defineProperty(render, COMPACT_RENDER, { value: true });
	proto.render = render;
}
