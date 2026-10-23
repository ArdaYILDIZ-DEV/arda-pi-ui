import { CustomEditor, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { markPromptLine, reportPromptError } from "./prompt-marker.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

const PROMPT_EDITOR = Symbol.for("arda-pi-ui.prompt-editor");

/** Keep the same editor instance and all its input/shortcut/autocomplete behavior. */
export function wrapPromptEditor<T extends EditorComponent>(editor: T): T {
	try {
		const original = editor.render;
		if (Reflect.get(original, PROMPT_EDITOR)) return editor;
		if (!editor.setPaddingX) throw new TypeError("Editor.setPaddingX is unavailable");
		const setPadding = editor.setPaddingX;
		let disabled = false;
		function render(this: T, width: number): string[] {
			if (disabled) return original.call(this, width);
			try {
				// Pi reapplies the user's padding setting after constructing the editor.
				setPadding.call(this, 2);
			} catch (error) {
				disabled = true;
				reportPromptError("Editor padding", error);
				return original.call(this, width);
			}
			const lines = original.call(this, width);
			try {
				const result = lines.slice();
				// Pi Editor emits one top border before its visible content lines.
				if (result.length > 1) result[1] = markPromptLine(result[1]);
				return result;
			} catch (error) {
				disabled = true;
				reportPromptError("Editor marker", error);
				return lines;
			}
		}
		Object.defineProperty(render, PROMPT_EDITOR, { value: true });
		editor.render = render;
	} catch (error) {
		reportPromptError("Editor patch", error);
	}
	return editor;
}

export function registerPromptEditor(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		try {
			const previous = ctx.ui.getEditorComponent();
			if (previous && Reflect.get(previous, PROMPT_EDITOR)) return;
			const factory: EditorFactory = (tui, theme, keybindings) => {
				try {
					const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
					return wrapPromptEditor(editor);
				} catch (error) {
					reportPromptError("Editor factory", error);
					return new CustomEditor(tui, theme, keybindings);
				}
			};
			Object.defineProperty(factory, PROMPT_EDITOR, { value: true });
			ctx.ui.setEditorComponent(factory);
		} catch (error) {
			reportPromptError("Editor setup", error);
		}
	});
}
