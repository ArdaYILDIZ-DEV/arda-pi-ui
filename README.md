# arda-pi-ui

Compact terminal UI for Pi: theme-aware tool views, edit diffs, live progress and a two-row status footer. Tool execution is unchanged.

## Installation

Requires Node.js 22.19+ and Pi 1.2.x (tested with Pi 1.2.0).

```sh
git clone https://github.com/ArdaYILDIZ-DEV/arda-pi-ui.git ~/.pi/agent/extensions/arda-pi-ui
```

Pi discovers the extension in this directory. Restart Pi or run `/reload` to load changes.

## Features

- **Header:** the original pixel “Pi” wordmark and falling-block entrance from pi-cc-header, with theme-aware information and configurable color/gradient/stripes. Reads existing `ccHeader` settings without migrating or writing them; see [Header configuration](#header-configuration).
- **Prompt markers:** shows `❯` on the first content line of the active editor and a dim `❯` on sent user messages. The editor uses Pi's public editor factory and padding APIs; custom editors without `setPaddingX` keep their existing rendering and log a compatibility warning. Very narrow editors without two padding columns are left unmarked.
- **Past user messages:** removes top and bottom padding while preserving OSC 133 prompt navigation. Uses the existing reload-safe render patch because Pi has no user-message render hook, and enforces at least two horizontal padding columns through `setOutputPad`. Setup failures are logged and leave the default renderer intact. Runtime padding or marker failures disable the customization for the affected component and are logged once rather than on every redraw.
- **Tools:** target/scope, text-based status, execution duration when available, and incomplete-output warnings. Expanded calls retain their tool name and full command.
- **Edits:** added/removed line counts, small inline previews and full syntax-highlighted diffs on expansion.
- **Themes:** uses the active Pi theme's semantic colors and appearance, including 256-color mode. No personal theme files are required.
- **Progress:** seven single-cell spinner animations, Turkish action/thinking text, elapsed time and live `tok/s`. Animations are chosen randomly at the start of each UI run and change while waiting, without consecutive repeats. Rates are estimates when the provider does not report live usage.
- **Footer:** model, folder, Git, context usage, cache share and session cost estimate. Other extensions' status entries appear below and wrap on narrow terminals. Context and cost take priority when space is limited; cache information that does not fit moves below instead of disappearing. Very narrow layouts retain the context percentage instead of a clipped model name.
- **Git:** one non-locking local status command per refresh, including detached HEAD and untracked files. Unchanged snapshots do not trigger redraws. GitHub is contacted only by `/git refresh`, not on startup or tool completion.
- **Cache:** shows the latest request’s recorded cache-read share alongside a fixed five-minute idle reminder. No extra model requests or cache settings changes. Audio reminders require an existing `mpv`, `ffplay` or macOS `afplay`.

The spinner switches after at least eight seconds, at the end of a complete animation loop (about 8–9 seconds). Transitions restart only the glyph clock, not the request timer, token rate or thinking state. All animations use the active theme's accent color, without flashes or added effects:

| Animation | Frames | Frame duration |
| --- | --- | --- |
| Original | Original forward/reverse glyphs, with the Ghostty adjustment preserved | 120 ms |
| Rotating line | `\| / - \` | 240 ms |
| Braille orbit | `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` | 100 ms |
| Interlacing helix | `⢎ ⢕ ⢣ ⢱ ⡱ ⡣ ⡕ ⡎` — two crossing trails with constant dot density | 140 ms |
| Breathing ripple | `⠒ ⠶ ⣶ ⣿ ⣿ ⠿ ⠶ ⠒ ⠒` — density wave with short rests at the extrema | 120 ms |
| Comet arc | `⠹ ⠛ ⠏ ⡇ ⣆ ⣤ ⣰ ⢸` — a continuous four-dot arc sweeping the perimeter | 90 ms |
| Diagonal weave | `⢣ ⢎ ⡜ ⡱` | 160 ms |

The idle reminder is not proof that a provider cache entry is still available. Costs are provider-recorded estimates, not invoices or subscription charges; unknown prices show `$? est`. Output line counts are not match counts, and expansion cannot recover content already truncated by a tool.

## Commands

| Command | Action |
| --- | --- |
| `/arda-header` | Show header settings for this session |
| `/arda-header on`, `off`, `reload`, `reset` | Show/hide the entire header, reload saved settings, or use defaults (session only) |
| `/arda-header replay` | Replay the falling-block logo animation without changing settings |
| `/arda-header <key> <value>` | Change a `ccHeader` setting for this session; booleans use `true`/`false` |
| `/arda-tools` | Show compact tool-view status |
| `/arda-tools on`, `off`, `toggle` | Enable, disable or toggle compact tool views |
| `/cache` | Show recorded read/write/uncached tokens, local idle time and audio status |
| `/cache toggle` | Show or hide the idle reminder |
| `/cache sound` | Toggle reminders; also accepts `on`, `off` or `test` |
| `/git` | Show Git status and cached open-PR information |
| `/git refresh` | Refresh local Git and query open-PR information via `gh` (network access) |

Only Pi's extension status entries are combined; custom widgets remain separate. Another extension that installs a footer later takes precedence. Headless sessions do not start UI timer loops or automatic Git inspections.

## Header configuration

Header settings remain in the global Pi `settings.json` under `ccHeader`, resolved through Pi's active agent directory (`getAgentDir()`, including `PI_CODING_AGENT_DIR`). Project settings are not merged into this block, matching pi-cc-header. Existing settings work without moving or renaming keys. There is no other central arda-pi-ui settings namespace to migrate to.

When migrating from pi-cc-header, remove only `npm:pi-cc-header` from `packages`, retain `ccHeader`, then restart Pi or run `/reload`. Do not load the old entry point explicitly. The new module checks registered extension command provenance and yields if pi-cc-header is still loaded, independent of session-handler order. This avoids competing header owners; it does not disable or modify the old package. Merely leaving its files in `node_modules` does not activate it.

For example, this existing block is supported unchanged:

```json
{
  "ccHeader": {
    "color": "a",
    "ver": 1,
    "grad": true,
    "lines": false,
    "pkg": false,
    "speed": 100,
    "slogan": "Gurur duyacağın bir şey kodla.",
    "sloganOn": true,
    "sloganColor": true,
    "disabled": false
  }
}
```

| Key | Default | Meaning / valid values |
| --- | --- | --- |
| `color` | `"c"` | `a` Anthropic, `c` Clawd, `r` red, `o` orange, `y` yellow, `g` green, `w` white, `b` blue, `p` purple; `theme` follows the host accent |
| `ver` | `1` | Color neither label nor version (`0`), only “Pi” (`1`), or both (`2`). The version is always displayed. |
| `grad` | `true` | Subtle vertical logo shading |
| `lines` | `true` | Horizontal stripe treatment within the logo, not divider lines around the header |
| `pkg` | `false` | Add a separate count of package-provided skills; local skill count remains visible |
| `speed` | `50` | Milliseconds per entrance frame: `25`, `50`, `75`, `100` (lower is faster) |
| `slogan` | `"Code something that makes you proud"` | Up to 85 UTF-16 code units, matching the legacy limit; empty is allowed |
| `sloganOn` | `true` | Show the slogan |
| `sloganColor` | `true` | Use the selected accent rather than muted text for the slogan |
| `disabled` | `false` | Render no header at all, including no built-in fallback; start no header timer |

Invalid fields independently fall back to defaults and produce a warning. Missing settings use defaults. Malformed/unreadable settings also use defaults and warn, but are **never repaired, backed up or overwritten** by the extension. Unknown fields, including legacy `readOnlyConfig`, are ignored; all header commands are already read-only with respect to disk. Command changes last until another session starts or `/arda-header reload` is used. For example: `/arda-header color theme`, `/arda-header speed 100`, `/arda-header slogan Your next idea`, `/arda-header sloganColor false`.

The six-row layout preserves the original pixel “Pi” lettering, falling red/cyan/green pieces, assembly flashes and final colored logo. Rendering uses the shared palette, active host appearance and color encoding. At fewer than 40 columns, text takes priority over the logo; strings are terminal-sanitized and truncated with Pi's grapheme-aware helpers. Explicit legacy colors are adapted for light-background readability. The original 22-frame entrance runs for startup/new sessions and stops completely afterward; reload/resume/fork render the settled mark immediately. Use `/arda-header replay` to watch it again after reloading. Replacement, shutdown and disposal cancel pending animation work. Non-TUI modes install nothing and start no header timers.

Resource counts use registered skill/prompt command metadata, not filesystem guesses or leftover npm directories. Skills whose slash commands are disabled are therefore not counted. “Packages” means configured global packages, including object-form entries, not the number of loaded extension files. This intentionally replaces the old approximate installed/residual extension count. Model/thinking level and theme are read afresh on render. Unlike pi-cc-header, this module never clears the terminal or changes `quietStartup`, `clearOnStart` or other Pi settings. Existing values of those settings remain untouched. Old `/hc`, `/hv`, etc. commands are replaced by `/arda-header`; destructive config-reset/uninstall commands are not carried over.

## Prompt caching

- `cache read 78%` means **78% of the latest real request’s input tokens were read from cache**, using Pi’s normalized `cacheRead / (input + cacheRead + cacheWrite)`. It is not the percentage of requests that hit, a prediction of the next hit, or monetary savings. Write-only usage is `0% read`, not a cache failure. Missing/invalid usage and failed/aborted requests do not reuse an older percentage. Zero counters mean Pi reported no cached tokens, not necessarily that the provider supports reporting them.
- `idle 1dk 20sn / 5dk` is a **local activity reminder**, not a provider expiry estimate. It stays at zero during generation, streamed tool arguments, tool execution and retries, then restarts when the agent settles. The host's `isIdle()` also guards lifecycle resets and restarts the reminder after host-only activity such as manual compaction. Long operations do not trigger overdue warnings when activity ends.
- The UI always uses the default five-minute window, independent of requested or catalog cache lifetimes. Footer and standalone widget use the same theme-aware ramp: warning at 3:00, smoothly reaching error at 5:00 and staying there afterward (yellow to red in the fallback palette). Standalone callers retain the public `ttlMs` option and provider-observation helpers. Each completed run starts a fresh window, even without a provider-request hook; duplicate settlement events do not restart it. Restored sessions seed the reminder from the latest assistant timestamp on the active branch, including across compaction, never user/tool entry times; historical elapsed sound milestones are skipped.
- Pi's successful `cache_warm` usage remains separate in `/cache`. It does not reset the local idle reminder or change the real request's cache-read share; refresh costs remain in session totals. Unknown or invalid usage is not invented.
- Automatic sound thresholds are **2:30, 4:00 and 4:30**; the final warning plays twice. Active or expired idle windows do not trigger sounds. `DEFAULT_CACHE_SOUND_RATIOS` and the public `soundMilestoneRatios` option remain configurable; invalid tuples fall back to defaults. The shared refresh loop continues even when the footer owns presentation or a frame fails to render; shutdown/disposal stops it.

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
- `header.ts`: pure header layout, finite animation ownership and `/arda-header` lifecycle integration.
- `header-logo.ts`: host-independent pixel “Pi” rasterization and falling-block choreography.
- `header-settings.ts`: typed, validated legacy `ccHeader` configuration and read-only global settings loading.
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

MIT, as declared in `package.json`. A standalone project license file is not included. The header was independently reimplemented after reviewing MIT-licensed pi-cc-header; its attribution and license notice are retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The original Pi wordmark and animation choreography are retained through a new sprite-based renderer; no upstream frame table or runtime dependency is included.
