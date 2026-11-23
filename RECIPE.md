# Quota

A sidebar panel that shows how much of your Claude Code, ChatGPT (Codex) and GitHub Copilot subscription quota is used. Each provider is one line: its name, your plan, the window that most needs attention and the percentage used. Click a provider to see all of its windows with a bar and a reset countdown.

![Quota](preview.png)

## What you see

A panel the width of the sidebar (built at 268px), sitting directly beneath Agents. It has the sidebar's chrome background and a 1px top border in the border color. Everything is drawn in theme colors, so it follows light and dark themes.

- **Header, 41px tall.** "Quota" at the left, 11.5px, medium weight, dim. At the right, the time of the newest reading (10px, dim, hours and minutes only), then a 26px settings button showing a 13px gear (`mods/workspace-chrome/settings.svg`, tooltip "Quota settings"), then a 26px refresh button showing "↻" with 6px corners. The button gets the hover background and foreground color under the pointer and the tooltip "Refresh quota".
- **One row per provider, 12px apart**, inset 16px from the left and 12px from the right: Claude, ChatGPT, GitHub Copilot. Left to right: the name (13px, semibold), the plan the provider reports with its first letter capitalized (9px, dim, for example "Max", "Plus", "Individual"), then at the right edge the most urgent window's label (10px, dim, for example "5h" or "1mo"), "6% used" (11px, semibold) and an 11px chevron pointing right.
- **An expanded provider** swaps its chevron to point down, drops the label and percentage from its row, and lists every window beneath, 5px apart. Each window is: its label (11px, muted) with "38% used" (11px, semibold) at the right; a 4px bar with 2px corners on a border-colored track, filled to the share that is used, with a 2px-wide, 8px-tall foreground-colored tick at the share of the window that has passed, where the fill would be at an even pace (shown when the window's start is known, moving right as the window runs); and "Resets in 2h 24m" (10px, dim).
- **Color means attention.** A reading is foreground-colored with a muted bar until 60% is used, the "working" color from 60% used or once usage is at least 20% and 10 or more points ahead of an even pace through the window (50% used a fifth of the way through), and the "blocked" color from 85% used.
- **A provider you have never signed in to** has no row. One line beneath the rows (10px, dim) names them: "Not signed in: ChatGPT, GitHub Copilot". They are still checked at every refresh, so a row appears once its sign-in exists.
- **An expired Claude sign-in** is a pause, not a failure: the last reading stays, with the same line in the dim color, "Stale, 3h old · Paused until Claude Code next runs".
- **A failed refresh** adds one 9.5px line in the "working" color under the provider: how old the reading is, then why, for example "Stale, 47m old · Rate limited; retry in 8m". A provider that fails with no earlier reading shows the reason alone, at 11px.

## How it behaves

- The gear opens a popup at the pointer, 230px wide, on the popover background: a dim 10.5px heading "Providers to check", then one 30px row per offered provider with its name and a 14px accent-colored check when it is on (`mods/workspace-chrome/check.svg`). A row gets the hover background under the pointer; clicking it turns the provider on or off. A provider that is on but has no sign-in also says "not signed in" (10px, dim). The popup is the same mod opened with `openOverlay({ mod: "quota", kind: "popup", props: { menu: true, … } })`.
- A provider turned off has no row and is not passed to the collector. Choices are saved in Herdr's shared store under `herdr-quota.settings` as `{ off: [ids], expanded: {id: true} }`. A change re-renders the panel, which reads again for the new choice. With every provider off the panel shows "No providers selected" (10px, dim) and does not run the collector.
- Beneath the providers the popup has a second heading, "Refresh every", and three rows of the same shape: "2 minutes", "5 minutes", "15 minutes", with the check on the chosen one (5 by default, saved as `minutes`).
- It reads quota when it first appears, then at the chosen interval, and when you click refresh. One timer ticks every minute; a tick reads again once the interval has passed since the last read began. While reading, the header shows "Updating…" in place of the time. With no reading at all it shows "Not updated".
- Countdowns and ages are redrawn on every tick between readings.
- Clicking anywhere on a provider's row expands or collapses it. Any number can be open. Providers start collapsed, and the open ones are remembered across restarts (in Herdr's shared store, under `herdr-quota.settings`).
- The collapsed row shows the provider's most urgent window: one at 85% used or more; failing that, one that is at least 20% used and 10 or more points ahead of an even pace; failing that, the most used. Within each of those the most used wins, and on a tie the first the provider lists.
- The panel resizes its own layout block to fit its rows, growing when a provider opens and shrinking when it closes. This only happens when the block sits in a column and has a fixed pixel height.
- A reading younger than a minute is reused, so a second refresh inside a minute shows the same numbers.
- When Claude or Copilot answers "rate limited", that provider is left alone for as long as it asks (ten minutes if it does not say) and its last reading stays on screen, marked stale.
- A window whose reset time has passed is hidden until the next successful reading.
- It shows no agent status and binds no keys.

## Built from

One mod, `mods/quota/`:

- `main.js`: the panel.
- `mod.json`: `{ "place": "none", "title": "Quota" }`. It appears only where a layout puts it.
- `collect.mjs` and `claude-credentials.mjs`: the collector, plain Node scripts (Node 22 or newer, no dependencies) that do all the reading and print one JSON object.

There is no `layouts/` folder. To show the panel, add this block to a layout the person owns, immediately after the block with id `agents`, inside the same column. Herdr's shipped `main` cannot have its structure edited in place, so clone it first (`layout.clone {name: "main", as: "quota-main"}`) and edit the clone:

```json
{ "id": "quota", "type": "block", "size": { "px": 220 }, "min": 110, "content": { "mod": "quota" } }
```

Optional prop on that block: `"props": { "providers": ["claude", "chatgpt"] }` chooses and orders what the panel offers from `claude`, `chatgpt`, `copilot`. Providers left out are not queried and are not listed in the settings.

From `herdr` the panel uses `appHome`, `checking`, `exec`, `layout`, `props`, `run("layout.resize", {id, px})`, `openOverlay`, `shared`, `setShared` and `theme`, plus `cx.timer.every` for the one-minute tick. Its chevrons are `mods/workspace-chrome/chevron-right.svg` and `chevron-down.svg`; the gear and the check come from the same folder.

The panel runs `node <appHome>/mods/quota/collect.mjs [provider ids]` with a 25-second timeout. The collector prints `{ providers, errors, absent, paused }`, where each provider is `{ plan, windows: [{ label, usedPercent, resetsAt, startsAt? }], fetchedAt, stale?, note? }`. `startsAt` is set when the window's length is known: 5 hours for Claude's session, 7 days for its weekly windows, the length Codex reports, and a calendar month for Copilot. It keeps its last readings and any cooldowns in `~/.cache/herdr-quota.json` (or under `XDG_CACHE_HOME`), written with mode 0600.

What the collector reaches, per provider:

- **Claude.** Reads the Claude Code sign-in: on macOS by running `/usr/bin/security find-generic-password -s "Claude Code-credentials" -w`, falling back to `~/.claude/.credentials.json`; elsewhere from that file. Keeps only the access token, its expiry and the plan name, and sends the access token to `https://api.anthropic.com/api/oauth/usage`, refusing redirects, with `anthropic-beta: oauth-2025-04-20` and the user-agent `herdr-quota/<version>`. The plan comes from the sign-in's `subscriptionType`.
- **ChatGPT.** Runs `codex app-server --stdio` and asks it, over JSON-RPC, `initialize`, `account/read` and `account/rateLimits/read`. It never sees a Codex credential.
- **Copilot.** Runs `gh api --include copilot_internal/user`, so the GitHub CLI makes the request and the collector never sees a GitHub token. The plan is `copilot_plan`; the reset date is `quota_reset_date_utc`.

Environment overrides: `CLAUDE_CONFIG_DIR`, `CODEX_BIN_PATH`, `GH_BIN_PATH`, `HERDR_QUOTA_CACHE`, and, for tests, `CLAUDE_SECURITY_COMMAND` and `GH_TIMEOUT_MS`.

## Watch out

- **Tell the person before adding it.** This mod reaches the network (Anthropic directly; OpenAI and GitHub through their own CLIs), runs programs (`node`, `security`, `codex`, `gh`) and reads a file outside its folder (Claude Code's credentials). The Claude access token is the only credential it handles, and no token is written to the cache, to the collector's output or to a log.
- **Two of the three endpoints are undocumented.** Anthropic's `oauth/usage` and GitHub's `copilot_internal/user` can change or disappear without notice. Copilot buckets marked unlimited, or without a usable percentage, are skipped.
- **`node` must be on the path Herdr runs programs with.** Without it the panel shows the failure in the "working" color at the bottom.
- **The folder name `quota` is assumed twice in `main.js`:** in the collector path and in the search for the panel's own layout block. If the mod is renamed to avoid a clash, change both.
- **The Claude token is never refreshed.** Claude Code does that when it runs. An expired sign-in is reported as "Paused until Claude Code next runs", in the dim color.
- **macOS may ask for Keychain access.** The collector waits three seconds; if the read fails and only an old credentials file is left, it says so instead of calling the sign-in expired.
- **This runtime ignores the options passed to `toLocaleTimeString`**, so the header strips the seconds itself.
- **`init()` runs during `herdr-app check`.** The refresh returns early when `checking()` is true, so a check never runs the collector.
- **Without a fixed pixel height in a column, the panel does not resize itself**; it scrolls instead.
- **Built on macOS and run on macOS and Linux.** The collector has a Windows path that has not been exercised.

## Done when

- `herdr-app check mods/quota` passes.
- `node mods/quota/collect.mjs` exits 0 and prints JSON with `providers`, `errors`, `absent` and `paused`, even on a machine with nothing signed in.
- The panel shows a row with a percentage for every chosen provider that is signed in, and names the rest on one "Not signed in: …" line.
- Clicking a row lists its windows and the block grows to fit; clicking again shrinks it back.
- Clicking refresh shows "Updating…" and then a time.
- `~/.cache/herdr-quota.json` contains percentages, reset times, plan names and timestamps, and no token.
