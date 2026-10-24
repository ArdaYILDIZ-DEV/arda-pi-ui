/** Arda's compact Pi UI: working indicator, two-row footer and tool views. */
import { UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSpinner } from "./spinner.ts";
import { registerCacheTimer } from "./cache-timer.ts";
import { registerGitInfo, formatGitSummary } from "./git-info.ts";
import { registerToolRenderers } from "./tool-renderers.ts";
import { registerFooter } from "./footer.ts";
import { installCompactUserMessagePatch } from "./user-message.ts";
import { registerPromptEditor } from "./prompt-editor.ts";
import { registerHeader } from "./header.ts";

export { registerHeader, HeaderComponent, buildHeaderLines } from "./header.ts";
export { DEFAULT_HEADER_CONFIG, parseHeaderConfig, readHeaderSettings } from "./header-settings.ts";

export { registerFooter, buildFooterLines } from "./footer.ts";
export { ToolDiffComponent, renderToolDiffLines } from "./tool-diff.ts";
export { setClaudeToolsEnabled as setToolsEnabled, isClaudeToolsEnabled as isToolsEnabled } from "./tool-renderers.ts";

export { registerSpinner, SpinnerController } from "./spinner.ts";
export {
	registerCacheTimer,
	CacheTimerController,
	CACHE_SOUND_MILESTONES,
	DEFAULT_CACHE_SOUND_RATIOS,
	playAudio,
	resolveSoundPath,
	buildCacheTimerLine,
} from "./cache-timer.ts";

export {
	registerGitInfo,
	GitInfoController,
	formatGitSummary,
	emptyGitInfoState,
	countChangedFiles,
} from "./git-info.ts";

export {
	registerToolRenderers,
	registerClaudeToolRenderers,
	restoreBuiltinToolRenderers,
	setClaudeToolsEnabled,
	isClaudeToolsEnabled,
	installGlobalClaudeToolPatch,
	uninstallGlobalClaudeToolPatch,
	isGlobalClaudeToolPatchInstalled,
	prettyToolLabel,
	genericDetail,
	genericSummary,
	addAssistantResponseMarker,
} from "./tool-renderers.ts";

function registerSafely<T>(feature: string, register: () => T): T | undefined {
	try {
		return register();
	} catch (error) {
		console.error(`[arda-pi-ui] ${feature} disabled during Pi API setup.`, error);
		return undefined;
	}
}

export default function (pi: ExtensionAPI): void {
	registerSafely("Compact user messages", () =>
		installCompactUserMessagePatch(UserMessageComponent.prototype),
	);
	registerSafely("Header", () => registerHeader(pi));
	registerSafely("Prompt editor", () => registerPromptEditor(pi));
	registerSafely("Spinner", () => registerSpinner(pi));
	const gitController = registerSafely("Git status", () => registerGitInfo(pi));
	const cacheController = registerSafely("Cache timer", () =>
		registerCacheTimer(
			pi,
			gitController
				? { gitInfoProvider: () => formatGitSummary(gitController.getState()) }
				: undefined,
		),
	);
	if (gitController && cacheController) {
		registerSafely("Git/cache integration", () =>
			gitController.addListener((state) => {
				cacheController.setGitInfoProvider(() => formatGitSummary(state));
			}),
		);
	}
	registerSafely("Footer", () =>
		registerFooter(pi, { git: gitController, cache: cacheController }),
	);
	registerSafely("Tool renderers", () => registerToolRenderers(pi));
}
