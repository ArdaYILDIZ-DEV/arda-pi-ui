import { markPromptLine, reportPromptError } from "./prompt-marker.ts";

const OSC133_START = "\x1b]133;A\x07";
const OSC133_END = "\x1b]133;B\x07\x1b]133;C\x07";
const COMPACT_RENDER = Symbol.for("arda-pi-ui.compact-user-message-render");
const PROMPT_RENDER = Symbol.for("arda-pi-ui.prompt-user-message-render");

interface UserMessageRenderer {
	render(width: number): string[];
	setOutputPad?(padding: number): void;
}

/** Pi exposes horizontal outputPad, but no user-message vertical padding hook. */
export function installCompactUserMessagePatch(proto: UserMessageRenderer): void {
	try {
		const original = proto.render;
		if (typeof original !== "function") {
			throw new TypeError("UserMessageComponent.render is unavailable");
		}
		// Keep the marker on the replacement function, shared across extension reloads.
		if (Reflect.get(original, PROMPT_RENDER)) return;
		// Upgrade a compact-only wrapper retained by Pi across /reload without
		// trimming its already compacted output for a second time.
		const alreadyCompact = Boolean(Reflect.get(original, COMPACT_RENDER));
		// Incompatible instances fall back independently, without render-loop log spam.
		const disabled = new WeakSet<UserMessageRenderer>();

		function render(this: UserMessageRenderer, width: number): string[] {
			if (disabled.has(this)) return original.call(this, width);
			// Public setter also rebuilds already-created messages. Avoid a second,
			// private rebuild patch and avoid invalidating Markdown on every render.
			try {
				const padding: unknown = Reflect.get(this, "outputPad");
				if (this.setOutputPad && (typeof padding !== "number" || padding < 2)) {
					this.setOutputPad(2);
				}
			} catch (error) {
				disabled.add(this);
				reportPromptError("User message padding", error);
				return original.call(this, width);
			}
			const lines = original.call(this, width);
			try {
				if (lines.length === 0 || (!alreadyCompact && lines.length < 3)) return lines;

				// Remove only Pi's prompt-zone markers, not styling or other terminal data.
				const body = (alreadyCompact ? lines : lines.slice(1, -1)).map((line) =>
					line.replace(/\x1b\]133;[ABC](?:\x07|\x1b\\)/g, ""),
				);
				body[0] = OSC133_START + markPromptLine(body[0], true);
				body[body.length - 1] += OSC133_END;
				return body;
			} catch (error) {
				disabled.add(this);
				reportPromptError("User message marker", error);
				return lines;
			}
		}

		// Prepare everything before the single prototype write so failure leaves it intact.
		Object.defineProperty(render, COMPACT_RENDER, { value: true });
		Object.defineProperty(render, PROMPT_RENDER, { value: true });
		proto.render = render;
	} catch (error) {
		reportPromptError("User message patch", error);
	}
}
