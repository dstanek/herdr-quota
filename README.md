# Herdr Quota

A native Herdr **desktop** sidebar panel for checking remaining subscription usage for Claude Code, ChatGPT, and (experimentally) GitHub Copilot.

The panel starts compact: each provider shows its current short-term window and remaining percentage. Click a provider to expand its other quota windows, percentages, and reset times.

## Install

### Requirements

- Herdr desktop app
- Node.js 22 or newer
- Claude Code and/or Codex CLI installed and signed in locally for the providers you want to see
- GitHub CLI (`gh`) installed and signed in with `gh auth login` to try experimental Copilot usage

### From a downloaded copy of this project

Open a terminal in the project directory and run:

```sh
node scripts/install.mjs
```

Then switch Herdr to the generated layout:

```sh
herdr-app do layout.switch '{"name":"quota-main"}'
```

The installer copies the mod and its collector to Herdr's mods folder and creates a new `quota-main` layout based on your existing `main` layout, placing Quota beneath Agents. It does not replace your existing layout or overwrite an existing Quota mod/layout. If either already exists, choose a different name or remove/rename that item before installing.

The default Herdr config directory is `~/.config/herdr-app`. If Herdr uses a custom directory, set `HERDR_APP_HOME` to that directory when running the installer.

### Provider setup

- **Claude:** use your existing Claude Code sign-in. On macOS, the mod reads the `Claude Code-credentials` item from Keychain first, then falls back to `~/.claude/.credentials.json`. Approve Keychain access if macOS prompts. On other platforms it reads the credentials file.
- **ChatGPT:** sign in to ChatGPT in Codex CLI. The mod asks Codex's local app-server for subscription limits; it does not use API-key billing as a substitute.
- **GitHub Copilot (experimental):** install GitHub CLI and run `gh auth login`. The collector obtains a token through `gh auth token`; the token is sent only to GitHub and is not written to the output or cache.

No Claude settings or status-line changes are required. A provider without a usable sign-in shows a status message rather than an estimated quota.

Copilot usage uses GitHub's undocumented `copilot_internal/user` endpoint. It is best-effort and not a stable or officially supported API; GitHub may change or remove it at any time. Only finite quota buckets with usable remaining percentages are shown.

## What it shows

- Short-term and weekly windows when reported by the provider.
- Remaining quota, reset countdown, and a progress bar in expanded details.
- Reading age; cached values are marked stale if a refresh fails.
- Only provider-reported values. Expired windows are hidden.
- Automatic refresh every five minutes, plus manual refresh from the panel header.

If Claude rate-limits requests, the collector backs off for the interval Claude asks for (ten minutes if it gives none). ChatGPT and Copilot have no backoff; a failed request is simply retried on the next refresh. In every case the last successful reading stays visible with its age. The cache is stored at `~/.cache/herdr-usage.json` (or under `XDG_CACHE_HOME`) and contains quota percentages, reset times, plan names, and fetch timestamps—not credentials. The cache filename is retained from the earlier Herdr Usage name so existing cached readings are preserved.

## Troubleshooting

- **No Claude data:** check that Claude Code is signed in. On macOS, approve the Keychain prompt if shown. If Claude reports a sign-in problem, open Claude Code and check its own auth status before retrying.
- **No ChatGPT data:** verify Codex CLI is installed and signed in with a ChatGPT account, not API-key auth.
- **No Copilot data:** verify `gh auth status` succeeds and that the GitHub account has Copilot access. The undocumented endpoint may also fail or change independently of this mod.
- **Rate limited (Claude):** the last successful reading remains visible if available. Wait for the displayed retry interval; avoid repeatedly pressing refresh.
- **Switch back to your original layout:** `herdr-app do layout.switch '{"name":"main"}'`.
- **Validate the installed mod:** `herdr-app check ~/.config/herdr-app/mods/quota`.

## Configuration and scope

There are currently no user-facing settings. The mod discovers the supported providers from their existing local sign-ins, so there is no provider setup file to maintain. The available choices (which providers to enable, refresh interval, or compact/expanded defaults) do not yet justify configuration: adding toggles would make the initial setup more involved without improving the default experience.

The implementation supports Claude Code and Codex/ChatGPT, plus experimental best-effort GitHub Copilot usage through an undocumented endpoint. More providers can be added when their local auth and quota interfaces can be read reliably. This is a Herdr desktop mod; the separate Herdr mobile app does not currently run desktop mods.

## Development checks

```sh
node --check scripts/collect.mjs
node --test
herdr-app check mods/quota
```
