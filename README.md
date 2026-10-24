# arda-pi-ui

A compact terminal interface for [Pi Coding Agent](https://github.com/earendil-works/pi): an animated pixel Pi header, live progress, readable tool output and a two-row status footer.

This extension changes presentation, not tool execution. It does not send model requests, warm provider caches, or write your Pi settings.

## Installation

Requires Node.js **22.19+** and Pi host packages compatible with **^1.2.0**. Development checks use Pi 1.2.0; isolated extension loading has also been checked with Pi 1.4.0.

Clone into Pi's default extension directory:

```sh
git clone https://github.com/ArdaYILDIZ-DEV/arda-pi-ui.git ~/.pi/agent/extensions/arda-pi-ui
```

Restart Pi or run `/reload`. Pi discovers the extension's `index.ts` automatically. If you use a custom agent directory, use its `extensions/arda-pi-ui` directory instead.

If **pi-cc-header** is already enabled, follow [Migrating from pi-cc-header](#migrating-from-pi-cc-header) before loading both. The new header yields to the old extension until you remove its package entry.

No separate theme files are needed. Audio reminders optionally use an existing `mpv`, `ffplay` or macOS `afplay`; open-PR refreshes optionally use an authenticated GitHub CLI (`gh`).

## What changes

- **Header:** the pixel “Pi” lettering and 22-frame falling-block animation from pi-cc-header, reimplemented as a standalone renderer. Colors, gradients, stripes, slogan and animation speed are configurable.
- **Progress:** 20 animations, Turkish action/thinking text, elapsed time and estimated live `tok/s`. Wide frames collapse to a single-cell marker in very narrow terminals.
- **Tool views:** compact target/scope and status, execution duration when available, and incomplete-output warnings. Expanded views retain tool identity, full commands and available diagnostics.
- **Edit previews:** added/removed line counts, small inline previews and syntax-highlighted expanded diffs.
- **Prompt markers:** `❯` in the editor and a dim marker on sent messages. Past messages lose outer padding while retaining OSC 133 prompt navigation.
- **Footer:** model, folder, Git, context usage, cache-read share, local idle reminder and estimated session cost. Other extensions' status entries wrap below.
- **Themes:** active host semantic colors, light/dark appearance and truecolor/256-color encoding. External text is sanitized before styling.

Context and cost take priority at narrow widths. Cache details that do not fit move below; very narrow layouts retain context percentage instead of a clipped model name. Unknown usage/prices stay unknown, including `$? est` for unpriced costs. Costs are recorded estimates, not invoices or subscription charges.

## Commands

| Command | Action |
| --- | --- |
| `/arda-header` | Show current header settings |
| `/arda-header on`, `off` | Show or hide the entire header |
| `/arda-header reload`, `reset` | Read saved header settings or use defaults |
| `/arda-header replay` | Replay the falling-block animation |
| `/arda-header <key> <value>` | Change a header setting for this session |
| `/arda-tools` | Show compact tool-view status |
| `/arda-tools on`, `off`, `toggle` | Change compact tool presentation |
| `/cache` | Show recorded cache usage, local idle time and audio status |
| `/cache toggle` | Show or hide the idle reminder |
| `/cache sound` | Toggle audio reminders; also accepts `on`, `off` or `test` |
| `/git` | Show local Git status and cached open-PR information |
| `/git refresh` | Refresh local Git and query open PRs through `gh` |

`/git refresh` contacts GitHub. Automatic Git refreshes use one non-locking local status command and do not contact GitHub. `/cache sound test` plays audio through an available player.

## Header settings

The header reads the **global** Pi `settings.json` from the active agent directory, resolved through Pi's `getAgentDir()` (including `PI_CODING_AGENT_DIR`). Settings remain under the legacy `ccHeader` key; no migration to a new namespace is required. Project settings are not merged into this block.

Merge this example into your existing settings; do not replace the whole file:

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

| Key | Default | Meaning |
| --- | --- | --- |
| `color` | `"c"` | `a` Anthropic, `c` Clawd, `r` red, `o` orange, `y` yellow, `g` green, `w` white, `b` blue, `p` purple, or `theme` for the host accent |
| `ver` | `1` | Color neither label nor version (`0`), only “Pi” (`1`), or both (`2`). The version remains visible in all modes. |
| `grad` | `true` | Shade the settled logo vertically |
| `lines` | `true` | Add horizontal stripes around the solid logo pixels, not header divider lines |
| `pkg` | `false` | Add a separate count of package-provided skills |
| `speed` | `50` | Milliseconds per frame: `25`, `50`, `75` or `100`; lower is faster |
| `slogan` | `"Code something that makes you proud"` | Up to 85 UTF-16 code units, matching the legacy limit; empty is allowed |
| `sloganOn` | `true` | Show the slogan |
| `sloganColor` | `true` | Use the selected accent instead of muted text |
| `disabled` | `false` | Show no header at all, including no built-in fallback; start no header timer |

Examples:

```text
/arda-header color theme
/arda-header speed 100
/arda-header slogan Your next idea
/arda-header sloganColor false
```

Commands change **only the current session**. Another session start or `/arda-header reload` reads persisted settings again. To make a change permanent, edit `ccHeader` yourself. Unknown keys, including legacy `readOnlyConfig`, are ignored; the extension never writes settings.

Invalid fields independently fall back to defaults and warn. A missing file uses defaults. Malformed/unreadable settings warn and use defaults without repairing, backing up or overwriting the file.

### Migrating from pi-cc-header

1. Remove only `npm:pi-cc-header` from your `packages` list.
2. Keep the existing `ccHeader` block.
3. Remove any explicit loading of the old entry point.
4. Restart Pi or run `/reload`; use `/arda-header replay` to preview the animation.

The module checks registered command provenance and does not install its header while pi-cc-header is loaded. Leaving the old package files in `node_modules` does not activate it.

The old `/hc`, `/hv`, etc. commands are replaced by `/arda-header`; destructive settings-reset/uninstall commands are not carried over. Unlike the old extension, this module does not clear the terminal or change `quietStartup`/`clearOnStart`. Existing values of those settings remain untouched.

### Layout and resource counts

The six-row layout keeps the original Pi lettering, falling red/cyan/green pieces, assembly flashes and final colored logo. At fewer than 40 columns, text takes priority over the logo. Text truncation follows Pi's grapheme-aware width helpers; explicit legacy colors adapt for light-background readability.

The entrance runs once for startup/new sessions. Reload/resume/fork show the final frame immediately. Replacement, shutdown and disposal cancel pending animation work.

Skill/prompt counts come from registered command metadata, not directory scans. Skills with disabled slash commands are not counted. Local skills remain visible; `pkg: true` adds package skills separately. “Packages” counts configured global package entries, not loaded extension files or leftover npm directories.

## Progress animations

Each UI run chooses randomly, without immediately repeating the previous animation. While waiting, the controller switches after **at least eight seconds**, at a completed animation-loop boundary. Transitions reset only the glyph clock, preserving request time, token rate and thinking state.

| Animation | Appearance | Frame duration |
| --- | --- | --- |
| Original | Forward/reverse glyph cycle, with the Ghostty adjustment preserved | 120 ms |
| Rotating line | `\| / - \\` | 240 ms |
| Braille orbit | Short trail around a braille cell | 100 ms |
| Interlacing helix | Two crossing, constant-density trails | 140 ms |
| Breathing ripple | Density wave with endpoint rests | 120 ms |
| Comet arc | Continuous four-dot perimeter arc | 90 ms |
| Diagonal weave | Staggered pairs crossing the cell | 160 ms |
| Scanner | Lit cell sweeps a five-cell bar and back | 90 ms |
| Signal | Broadcast arcs grow and recede | 130 ms |
| Binary | Five-bit Gray-code counter, one bit changes per frame | 70 ms |
| Pivot | Box-drawing stroke turns around a cell | 110 ms |
| Calculus | Math/ML notation cycles in place | 200 ms |
| Blink | Small face pauses, then blinks | 160 ms |
| Typing | Three dots rise and fall | 150 ms |
| Twinkle | Three stars brighten out of phase | 180 ms |
| Focus | Dot grows and shrinks inside brackets | 140 ms |
| Morse | Dot/dash sequence scrolls through six cells | 130 ms |
| DNA | Two braille strands scroll through a four-cell double helix | 110 ms |
| Rain | Dots fall through four staggered braille cells | 120 ms |
| Newton's cradle | End balls swing outward and pass the motion across | 130 ms |

All spinner animations use the active theme's accent color. Some span several cells; the formatter measures the actual frame width and falls back to a single-cell dot when necessary. Unicode appearance can still depend on terminal fonts. Token rates are estimates when the provider does not report live usage.

## Cache readout and idle reminders

These are separate signals, not evidence that a provider cache remains available:

- **`cache read 78%`**: 78% of the latest real request's input was read from cache, using Pi's normalized `cacheRead / (input + cacheRead + cacheWrite)`. It is not the percentage of requests that hit or a savings estimate. Write-only usage shows 0%; missing/invalid or failed/aborted usage does not reuse an older percentage.
- **`idle 1dk 20sn / 5dk`**: a local, fixed five-minute activity reminder. It stays fresh while processing, streaming tool arguments, retrying or running tools, then restarts when the agent settles. Host activity such as manual compaction is also guarded through `isIdle()`.
- **Colors**: warning at 3:00, transitioning smoothly to error at 5:00 and staying there afterward. In the fallback palette this is yellow to red, for both footer and standalone widget.
- **Audio**: enabled by default, with reminders at 2:30, 4:00 and 4:30; the last plays twice. Active/expired windows do not trigger reminders. `/cache sound off` disables audio for the session.
- **Restored sessions**: seed idle time from the latest assistant timestamp on the active branch, including across compaction; historical audio milestones are skipped.
- **Host warming**: Pi's `cache_warm` usage appears separately in `/cache`, does not restart the reminder and remains included in session costs. Unknown prices are not replaced with zero.

The shared refresh loop continues when the footer owns presentation and stops on shutdown/disposal. Standalone callers retain `ttlMs`, `soundMilestoneRatios` and provider-observation helpers.

The extension never pads prompts or sends warmup requests. Pi itself may support [cache warming settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md#model-and-thinking); that is a host/provider feature and can incur usage charges. This extension does not change it.

## Compatibility and troubleshooting

- **No animation after reload:** expected; run `/arda-header replay` or start a new session.
- **New header stays inactive:** remove pi-cc-header from enabled packages/explicit loading, then reload.
- **No sound:** check that a supported player and working audio output exist; `/cache sound test` intentionally plays a test sound.
- **Unexpected header defaults:** check the warning and validate the global settings file. Invalid fields fall back independently; the file is not rewritten.
- **Another custom header/footer wins:** these are shared Pi UI slots. This extension guards against pi-cc-header, but unrelated extensions can still replace them.
- **Custom editor has no marker:** editors without `setPaddingX`, or too little width for two padding columns, retain their rendering. Unsupported padding/marker APIs warn and leave the affected component unmodified.
- **Output is still incomplete after expansion:** rendering cannot recover content a tool already truncated.
- **Headless sessions:** the header installs nothing outside TUI mode; non-UI sessions do not start progress/cache timer loops or automatic Git inspection. RPC availability does not imply terminal appearance is supported.

Tool rendering prefers Pi's public `registerToolRenderer` API. Legacy re-registration/prototype helpers remain available for standalone compatibility callers. Sent-message compaction uses a reload-safe render patch because Pi has no equivalent public hook.

## Development

From the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
node --test tests/header.test.ts
node --test tests/spinner-animations.test.ts
npm test
```

Tests run TypeScript directly; there is no emitted build step. The full suite runs sequentially to avoid contention in timing-sensitive checks. Command runners and audio players are mocked, and the Pi loader check uses a disposable agent directory. These checks do not establish live terminal appearance or real audio playback.

### Module guide

| Module | Responsibility |
| --- | --- |
| `index.ts` | Feature composition, public exports and isolated setup failures |
| `header.ts`, `header-logo.ts`, `header-settings.ts` | Layout/lifecycle, pure pixel animation and read-only validated settings |
| `spinner.ts` | Animation selection/cadence, progress, thinking and stream-rate tracking |
| `footer.ts` | Responsive composition, recorded session cost and subscriptions |
| `cache-timer.ts` | Activity lifecycle, shared refresh loop, audio milestones and `/cache` |
| `prompt-cache.ts`, `cache-display.ts` | Provider observations, cache colors and display primitives |
| `audio.ts` | Player detection, sound resolution and best-effort local playback |
| `git-info.ts` | Local Git snapshots and explicit PR refreshes |
| `tool-renderers.ts` | Public renderer integration, compact views and compatibility helpers |
| `tool-diff.ts`, `word-diff.ts` | Diff parsing, layout and bounded word comparison |
| `prompt-editor.ts`, `prompt-marker.ts`, `user-message.ts` | Editor/sent-message markers and compact padding |
| `palette.ts`, `pi-compat.ts` | Terminal sanitization, widths, theme handling and guarded notifications |

The layout stays flat. Imports from `index.ts` and individual feature modules remain available; `cache-timer.ts` re-exports extracted audio/display helpers for standalone callers. No runtime dependencies beyond Pi host packages are added.

## License

MIT, as declared in `package.json`; a standalone project license file is not included. The Pi wordmark/animation was reimplemented after reviewing MIT-licensed pi-cc-header. Its copyright and permission notice, with design attribution, are retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
