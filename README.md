# arda-pi-ui

Compact terminal UI for Pi: theme-aware tool views, edit diffs, live progress and a two-row status footer. Tool execution is unchanged.

## Installation

Requires Node.js 22.19+ and Pi 1.2.x (tested with Pi 1.2.0).

```sh
git clone https://github.com/ArdaYILDIZ-DEV/arda-pi-ui.git ~/.pi/agent/extensions/arda-pi-ui
```

Pi discovers the extension in this directory. Restart Pi or run `/reload` to load changes.

## Features

- **Tools:** target/scope, text-based status, execution duration when available, and incomplete-output warnings. Expanded calls retain their tool name and full command.
- **Edits:** added/removed line counts, small inline previews and full syntax-highlighted diffs on expansion.
- **Themes:** uses the active Pi theme's semantic colors and appearance, including 256-color mode. No personal theme files are required.
- **Progress:** animated spinner, Turkish action/thinking text, elapsed time and live `tok/s`. Rates are estimates when the provider does not report live usage.
- **Footer:** model, folder, Git, context usage, cache share and session cost estimate. Other extensions' status entries appear below and wrap on narrow terminals. Context and cost take priority when space is limited; very narrow layouts retain the context percentage instead of a clipped model name.
- **Git:** one non-locking local status command per refresh, including detached HEAD and untracked files. Unchanged snapshots do not trigger redraws. GitHub is contacted only by `/git refresh`, not on startup or tool completion.
- **Cache:** shows the latest request’s recorded cache-read share alongside a fixed five-minute idle reminder. No extra model requests or cache settings changes. Audio reminders require an existing `mpv`, `ffplay` or macOS `afplay`.

The idle reminder is not proof that a provider cache entry is still available. Costs are provider-recorded estimates, not invoices or subscription charges; unknown prices show `$? est`. Output line counts are not match counts, and expansion cannot recover content already truncated by a tool.

## Commands

| Command | Action |
| --- | --- |
| `/arda-tools` | Show compact tool-view status |
| `/arda-tools on`, `off`, `toggle` | Enable, disable or toggle compact tool views |
| `/cache` | Show recorded read/write/uncached tokens, local idle time and audio status |
| `/cache toggle` | Show or hide the idle reminder |
| `/cache sound` | Toggle reminders; also accepts `on`, `off` or `test` |
| `/git` | Show Git status and cached open-PR information |
| `/git refresh` | Refresh local Git and query open-PR information via `gh` (network access) |

Only Pi's extension status entries are combined; custom widgets remain separate. Another extension that installs a footer later takes precedence. Headless sessions do not start UI timer loops or automatic Git inspections.

## Prompt caching

- `cache read 78%` means **78% of the latest real request’s input tokens were read from cache**, using Pi’s normalized `cacheRead / (input + cacheRead + cacheWrite)`. It is not the percentage of requests that hit, a prediction of the next hit, or monetary savings. Write-only usage is `0% read`, not a cache failure. Missing/invalid usage and failed/aborted requests do not reuse an older percentage. Zero counters mean Pi reported no cached tokens, not necessarily that the provider supports reporting them.
- `idle 1dk 20sn / 5dk` is a **local activity reminder**, not a provider expiry estimate. It stays at zero during generation, streamed tool arguments, tool execution and retries, then restarts when the agent settles. Long operations do not trigger overdue warnings at settlement. The host's `isIdle()` also guards against activity during lifecycle resets.
- The UI always uses the default five-minute window, independent of requested or catalog cache lifetimes. It turns yellow at 3:00, smoothly red by 5:00, and stays red afterward. Standalone callers retain the public `ttlMs` option and provider-observation helpers. Restored sessions seed the reminder from the latest assistant timestamp on the active branch, never user/tool entry times; historical elapsed sound milestones are skipped.
- Pi's successful `cache_warm` usage remains separate in `/cache`. It does not reset the local idle reminder or change the real request's cache-read share; refresh costs remain in session totals. Unknown or invalid usage is not invented.
- Automatic sound thresholds are **2:30, 4:00 and 4:30**; the final warning plays twice. Active or expired idle windows do not trigger sounds. `DEFAULT_CACHE_SOUND_RATIOS` and the public `soundMilestoneRatios` option remain configurable; invalid tuples fall back to defaults. The shared refresh loop continues even when the footer owns presentation.

### Keeping caches warm without wasted requests

Prefer ordinary requests that reuse a stable system/tool prefix and session routing key. Put changing material later; avoid unnecessary model, tool, system-prompt and thinking-setting changes. Do not pad prompts or send “ping” messages merely to make the indicator green. A small standalone ping generally cannot refresh the large conversation prefix. The extension does not alter context, retention, routing, or provider cache resources.

Pi 1.2 already has [economic cache warming](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md#model-and-thinking): `cacheWarming: "streaming"` is its default, `"idle"` additionally considers between-run refreshes, and `"off"` disables them. `/session` shows decisions. These are **global Pi settings**; this extension does not write or enable them. Warming replays the prefix with a one-token output cap, but still bills a cache read (or a costly miss) and output. Pi requires a declared lifetime and at least $0.05 estimated net benefit, refreshes before the window ends, skips unsafe budget-based Anthropic thinking replays and bounds warming duration. Idle continuation likelihood and prices are estimates, not guaranteed savings. Longer requested retention can avoid repeated refreshes, but Anthropic’s higher write price and provider/model support must be weighed against expected reuse. No second warmer is added here.

## Development

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

`npm test` runs the full test suite sequentially to avoid timing-sensitive tests contending with one another. Tests mock command runners and audio processes; the loader check uses a disposable agent directory. These checks do not verify live terminal appearance or real audio playback.

### Module responsibilities

The layout stays flat: each module owns a feature or a shared rendering primitive, without a service/container layer.

- `index.ts`: composition and public exports; setup failures are isolated per feature.
- `spinner.ts`: progress formatting, stream-rate tracking and spinner lifecycle.
- `footer.ts`: responsive footer composition, recorded session cost and subscriptions.
- `cache-timer.ts`: cache lifecycle, shared refresh loop, sound milestones and `/cache`.
- `prompt-cache.ts`: bounded request metadata and provider-usage observations.
- `cache-display.ts`: cache colors, time formatting and standalone widget layout; no audio or controller dependency.
- `audio.ts`: local player detection, sound-file resolution and best-effort playback.
- `git-info.ts`: local Git snapshots and explicit PR refreshes.
- `tool-renderers.ts`: Pi 1.2's public renderer resolver and compact views. Existing standalone compatibility helpers share one builtin registration loop; they are not the normal integration path.
- `tool-diff.ts` / `word-diff.ts`: diff parsing, highlighting/layout and bounded word comparison.
- `palette.ts` / `pi-compat.ts`: terminal sanitization, grapheme-aware widths, theme colors and guarded notifications.

Imports from `index.ts` and existing feature modules remain available. In particular, `cache-timer.ts` re-exports the extracted audio and display utilities for standalone callers. New internal code imports the owning module directly. No runtime dependencies beyond the Pi host packages are added.

## License

MIT, as declared in `package.json`. A standalone license file is not included.
