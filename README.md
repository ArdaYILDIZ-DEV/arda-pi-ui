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
- **Cache:** separates the latest request’s recorded cache-read share from cache age and a qualified lifetime estimate. No extra model requests or cache settings changes. Audio reminders require an existing `mpv`, `ffplay` or macOS `afplay`.

Cache age is not proof that a provider entry is still available. Costs are provider-recorded estimates, not invoices or subscription charges; unknown prices show `$? est`. Output line counts are not match counts, and expansion cannot recover content already truncated by a tool.

## Commands

| Command | Action |
| --- | --- |
| `/arda-tools` | Show compact tool-view status |
| `/arda-tools on`, `off`, `toggle` | Enable, disable or toggle compact tool views |
| `/cache` | Show recorded read/write/uncached tokens, cache age, uncertainty and audio status |
| `/cache toggle` | Show or hide the age segment |
| `/cache sound` | Toggle reminders; also accepts `on`, `off` or `test` |
| `/git` | Show Git status and cached open-PR information |
| `/git refresh` | Refresh local Git and query open-PR information via `gh` (network access) |

Only Pi's extension status entries are combined; custom widgets remain separate. Another extension that installs a footer later takes precedence. Headless sessions do not start UI timer loops or automatic Git inspections.

## Prompt caching

- `cache read 78%` means **78% of the latest real request’s input tokens were read from cache**, using Pi’s normalized `cacheRead / (input + cacheRead + cacheWrite)`. It is not the percentage of requests that hit, a prediction of the next hit, or monetary savings. Write-only usage is `0% read`, not a cache failure. Missing/invalid usage and failed/aborted requests do not reuse an older percentage. Zero counters mean Pi reported no cached tokens, not necessarily that the provider supports reporting them.
- `age 1dk 20sn / ~5dk` compares time since a cache-bearing **request started** against a requested/cache-catalog best-effort window. Generation and tools consume this time; settlement does not refresh it. The clock does not pretend to become fresh while another request is processing. `~` means an estimate, **not a server expiry time or guaranteed warm cache**. Mixed TTLs use the earliest window; they do not describe a single lease for the entire prompt.
- Without a verified positive read/write count there is no provider-age badge. Without an observed lifetime, `age … / ~5dk*` uses a **five-minute local fallback**. `*` means the provider lifetime is unknown, not that the provider promises five minutes. Restored sessions use the latest assistant’s request timestamp on the active branch, never user/tool entry times or a different model. Retention is not persisted in ordinary assistant messages, so it is not reconstructed from current settings. Model/branch changes and compaction invalidate in-memory lifetime metadata.
- Pi’s successful `cache_warm` usage entries are kept separate: `warm age ~… / ~5dk*` measures approximate time since refresh **completion**, not a new lease for the entire latest prompt. The real request’s read percentage stays unchanged and refresh costs remain in session totals. Other auxiliary usage does not count as a main-prompt refresh.
- Sound warnings apply to positive cache evidence, using the observed window or the five-minute fallback. Thresholds are **50%, 80%, 90%**: for five minutes, 2:30 / 4:00 / 4:30; for ten minutes, 5:00 / 8:00 / 9:00. The final warning plays twice. Expired windows and processing do not trigger automatic sounds. Change the single `DEFAULT_CACHE_SOUND_RATIOS` tuple in `cache-timer.ts`, or pass `soundMilestoneRatios: [0.5, 0.8, 0.9]` to `registerCacheTimer` / `CacheTimerController`; every duration scales automatically. Custom ratios must be strictly increasing between zero and one; invalid settings fall back to the defaults. Standalone callers without model metadata retain a configurable **local idle reminder**, not provider-state reporting.

### Provider differences

| Provider | What the extension can responsibly show |
| --- | --- |
| [Anthropic](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) | Request `cache_control`: default 5 minutes or explicit 1 hour; reuse refreshes from request start. Writes usually cost 1.25× / 2× ordinary input respectively; reads are discounted. Minimum prefix length and pricing vary by model. |
| [OpenAI](https://platform.openai.com/docs/guides/prompt-caching) | Model/request-specific: newer explicit-cache APIs use `prompt_cache_options.ttl: "30m"`; older `in_memory` retention is typically 5–10 idle minutes, up to an hour. `24h` is an upper retention bound, **not a guaranteed 24-hour refreshed lease**: only the host catalog’s conservative `long` window is used for it. Defaults and supported modes vary by model and organization. |
| [Gemini](https://ai.google.dev/gemini-api/docs/generate-content/caching) | Implicit-cache hits are measurable, but the official guide does not give a fixed implicit lifetime. Explicit caches are separate resources, default to one hour and charge storage by duration; that default is **not** assigned to Pi’s implicit cache. |
| [xAI](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices) | Cached-token usage is useful; entries may be evicted at any time. Conversation affinity improves routing, not guarantees. No fixed provider lifetime is claimed; the five-minute local fallback is marked `*`. |
| [Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html) | Model/API-specific checkpoints and TTLs, often five minutes with one-hour options on supported models. Read/write usage and outgoing checkpoint TTLs determine the display; checkpoint thresholds vary by model. |
| Other providers/proxies | Use actual Pi usage and the active host model’s `promptCache` metadata when available. Missing metadata uses the marked five-minute local fallback; no model-name heuristics or personal configuration files. |

The extension observes public Pi 1.2 request/message events and `Model.promptCache` (seconds). It only inspects cache directives and structural containers in outgoing payloads, never changes them or stores prompt text. Exact prefix equality, routing, token thresholds and early eviction still determine reuse. The [Pi model documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#prompt-cache-lifetimes) calls catalog lifetimes best-effort; custom model overrides are user declarations, not provider confirmation.

### Keeping caches warm without wasted requests

Prefer ordinary requests that reuse a stable system/tool prefix and session routing key. Put changing material later; avoid unnecessary model, tool, system-prompt and thinking-setting changes. Do not pad prompts or send “ping” messages merely to make the indicator green. A small standalone ping generally cannot refresh the large conversation prefix. The extension does not alter context, retention, routing, or provider cache resources.

Pi 1.2 already has [economic cache warming](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md#model-and-thinking): `cacheWarming: "streaming"` is its default, `"idle"` additionally considers between-run refreshes, and `"off"` disables them. `/session` shows decisions. These are **global Pi settings**; this extension does not write or enable them. Warming replays the prefix with a one-token output cap, but still bills a cache read (or a costly miss) and output. Pi requires a declared lifetime and at least $0.05 estimated net benefit, refreshes before the window ends, skips unsafe budget-based Anthropic thinking replays and bounds warming duration. Idle continuation likelihood and prices are estimates, not guaranteed savings. Longer requested retention can avoid repeated refreshes, but Anthropic’s higher write price and provider/model support must be weighed against expected reuse. No second warmer is added here.

## Development

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

`npm test` runs the full test suite sequentially to avoid timing-sensitive tests contending with one another.

## License

MIT, as declared in `package.json`. A standalone license file is not included.
