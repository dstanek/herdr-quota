import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readClaudeCredentials } from "../scripts/claude-credentials.mjs";

// Points every provider at nothing, so a test reaches only what it sets up itself.
function isolatedEnv(directory, overrides = {}) {
  return {
    ...process.env,
    HERDR_USAGE_CACHE: join(directory, "cache.json"),
    CLAUDE_CONFIG_DIR: join(directory, "claude"),
    CLAUDE_SECURITY_COMMAND: join(directory, "missing-security"),
    CODEX_BIN_PATH: join(directory, "missing-codex"),
    GH_BIN_PATH: join(directory, "missing-gh"),
    ...overrides,
  };
}

test("Claude credentials prefer Keychain on macOS and fall back to the credential file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-keychain-test-"));
  const keychain = join(directory, "security");
  const configDir = join(directory, ".claude");
  await mkdir(configDir);
  await writeFile(join(configDir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "file-token" },
  }));
  await writeFile(keychain, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } })}'\n`);
  await chmod(keychain, 0o755);
  try {
    const preferred = await readClaudeCredentials({ platform: "darwin", configDir, securityCommand: keychain });
    assert.equal(preferred.claudeAiOauth.accessToken, "keychain-token");
    const fallback = await readClaudeCredentials({
      platform: "darwin",
      configDir,
      securityCommand: join(directory, "missing-security"),
    });
    assert.equal(fallback.claudeAiOauth.accessToken, "file-token");
    const otherPlatform = await readClaudeCredentials({ platform: "linux", configDir });
    assert.equal(otherPlatform.claudeAiOauth.accessToken, "file-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collector keeps cached quota visible with its original timestamp during cooldown", async () => {
  const now = Date.now();
  const directory = await mkdtemp(join(tmpdir(), "herdr-quota-cooldown-test-"));
  const cachePath = join(directory, "cache.json");
  await writeFile(cachePath, JSON.stringify({
    providers: {
      claude: {
        fetchedAt: now - 30 * 60_000,
        windows: [
          { label: "5-hour", usedPercent: 25, resetsAt: now + 2 * 60 * 60_000 },
          { label: "Weekly", usedPercent: 40, resetsAt: now + 4 * 24 * 60 * 60_000 },
        ],
      },
      chatgpt: {
        fetchedAt: now - 30 * 60_000,
        plan: "plus",
        windows: [{ label: "7d", usedPercent: 60, resetsAt: now + 4 * 24 * 60 * 60_000 }],
      },
    },
    retryAfter: { claude: now + 5 * 60_000, chatgpt: now + 5 * 60_000 },
  }));
  try {
    const result = spawnSync(process.execPath, ["scripts/collect.mjs"], {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      encoding: "utf8",
      env: isolatedEnv(directory),
    });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.providers.claude.stale, true);
    assert.equal(snapshot.providers.claude.fetchedAt, now - 30 * 60_000);
    assert.deepEqual(snapshot.providers.claude.windows.map((window) => window.label), ["5-hour", "Weekly"]);
    assert.match(snapshot.errors.claude, /retry in 5m/);
    assert.doesNotMatch(result.stdout, /accessToken|Bearer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired Claude OAuth credentials suppress usage requests and clear retry cooldown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-quota-auth-test-"));
  const cachePath = join(directory, "cache.json");
  const configDir = join(directory, "claude");
  const now = Date.now();
  await mkdir(configDir);
  await writeFile(join(configDir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "test-only-token", expiresAt: now - 1000 },
  }));
  await writeFile(cachePath, JSON.stringify({
    providers: {},
    retryAfter: { claude: now + 10 * 60_000, chatgpt: now + 10 * 60_000 },
  }));
  try {
    const result = spawnSync(process.execPath, ["scripts/collect.mjs"], {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      encoding: "utf8",
      env: isolatedEnv(directory),
    });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.errors.claude, "Claude sign-in expired; run claude to refresh it");
    assert.doesNotMatch(result.stdout, /test-only-token|Bearer/);
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(cache.retryAfter.claude, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude parses session, weekly, and per-model windows from either response shape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-claude-test-"));
  const configDir = join(directory, "claude");
  const preloadPath = join(directory, "mock-fetch.mjs");
  await mkdir(configDir);
  await writeFile(join(configDir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "test-claude-token", expiresAt: Date.now() + 60 * 60_000 },
  }));
  const bodies = {
    limits: { limits: [
      { kind: "session", percent: 25, resets_at: "2030-01-01T00:00:00Z" },
      { kind: "weekly_all", percent: 40, resets_at: "2030-01-05T00:00:00Z" },
      { kind: "weekly_scoped", percent: 10, scope: { model: { display_name: "Opus" } }, resets_at: "2030-01-05T00:00:00Z" },
      { kind: "session", percent: "not-a-number" },
    ] },
    utilization: {
      five_hour: { utilization: 12, resets_at: "2030-01-01T00:00:00Z" },
      seven_day: { utilization: 130, resets_at: null },
      seven_day_opus: null,
    },
  };
  try {
    const windows = {};
    for (const [shape, body] of Object.entries(bodies)) {
      await writeFile(preloadPath, `
        globalThis.fetch = async (url, options) => {
          if (url !== "https://api.anthropic.com/api/oauth/usage") throw new Error("unexpected url");
          if (options.headers.authorization !== "Bearer test-claude-token") throw new Error("missing auth");
          return new Response(${JSON.stringify(JSON.stringify(body))});
        };
      `);
      const result = spawnSync(process.execPath, ["--import", preloadPath, "scripts/collect.mjs"], {
        cwd: dirname(dirname(fileURLToPath(import.meta.url))),
        encoding: "utf8",
        env: isolatedEnv(directory, { HERDR_USAGE_CACHE: join(directory, `${shape}.json`) }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /test-claude-token|Bearer/);
      windows[shape] = JSON.parse(result.stdout).providers.claude.windows;
    }
    assert.deepEqual(windows.limits, [
      { label: "5h", usedPercent: 25, resetsAt: Date.parse("2030-01-01T00:00:00Z") },
      { label: "7d", usedPercent: 40, resetsAt: Date.parse("2030-01-05T00:00:00Z") },
      { label: "7d Opus", usedPercent: 10, resetsAt: Date.parse("2030-01-05T00:00:00Z") },
    ]);
    assert.deepEqual(windows.utilization, [
      { label: "five hour", usedPercent: 12, resetsAt: Date.parse("2030-01-01T00:00:00Z") },
      { label: "seven day", usedPercent: 100, resetsAt: null },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collector starts Codex with a fixed app-server argv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-codex-argv-test-"));
  const codexPath = join(directory, "codex");
  const argvPath = join(directory, "argv");
  await writeFile(codexPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvPath}'\n`);
  await chmod(codexPath, 0o755);
  try {
    const result = spawnSync(process.execPath, ["scripts/collect.mjs"], {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      encoding: "utf8",
      env: isolatedEnv(directory, { CODEX_BIN_PATH: codexPath }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(argvPath, "utf8"), "app-server\n--stdio\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing CLIs are reported against their own provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-quota-missing-test-"));
  try {
    const result = spawnSync(process.execPath, ["scripts/collect.mjs"], {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      encoding: "utf8",
      env: isolatedEnv(directory),
    });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.errors.chatgpt, "Codex CLI not found; sign in with ChatGPT in Codex");
    assert.equal(snapshot.errors.copilot, "GitHub CLI sign-in not found; run gh auth login");
    assert.equal(snapshot.errors.claude, "No Claude Code sign-in found");
    assert.deepEqual(snapshot.absent, { claude: true, chatgpt: true, copilot: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex exiting mid-conversation fails only the ChatGPT provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-codex-exit-test-"));
  const codexPath = join(directory, "codex");
  await writeFile(codexPath, "#!/bin/sh\nread line\necho '{\"id\":1,\"result\":{}}'\n");
  await chmod(codexPath, 0o755);
  try {
    const result = spawnSync(process.execPath, ["scripts/collect.mjs"], {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      encoding: "utf8",
      env: isolatedEnv(directory, { CODEX_BIN_PATH: codexPath }),
    });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.ok(snapshot.errors.chatgpt);
    assert.equal(snapshot.absent.chatgpt, undefined);
    assert.equal(snapshot.errors.copilot, "GitHub CLI sign-in not found; run gh auth login");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed cached windows are ignored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-quota-cache-test-"));
  const cachePath = join(directory, "cache.json");
  const now = Date.now();
  await writeFile(cachePath, JSON.stringify({
    providers: {
      claude: { fetchedAt: now, windows: "x" },
      chatgpt: { fetchedAt: now, windows: [null, { label: "5h", usedPercent: 10, resetsAt: now + 60 * 60_000 }] },
    },
  }));
  try {
    const result = spawnSync(process.execPath, ["scripts/collect.mjs"], {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      encoding: "utf8",
      env: isolatedEnv(directory),
    });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.providers.claude, undefined);
    assert.deepEqual(snapshot.providers.chatgpt.windows.map((window) => window.label), ["5h"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex windows are labelled by duration, or by slot when no duration is reported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-codex-label-test-"));
  const codexPath = join(directory, "codex");
  await writeFile(codexPath, `#!/bin/sh
read line; echo '{"id":1,"result":{}}'
read line; read line; echo '{"id":2,"result":{"account":{"type":"chatgpt"}}}'
read line; echo '{"id":3,"result":{"rateLimits":{"primary":{"usedPercent":5,"windowDurationMins":300},"secondary":{"usedPercent":40}}}}'
sleep 1
`);
  await chmod(codexPath, 0o755);
  try {
    const result = spawnSync(process.execPath, ["scripts/collect.mjs"], {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      encoding: "utf8",
      env: isolatedEnv(directory, { CODEX_BIN_PATH: codexPath }),
    });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.deepEqual(snapshot.providers.chatgpt.windows.map((window) => window.label), ["5h", "secondary"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot parses finite quota snapshots using gh auth without caching credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-copilot-test-"));
  const cachePath = join(directory, "cache.json");
  const ghPath = join(directory, "gh");
  const preloadPath = join(directory, "mock-fetch.mjs");
  await writeFile(ghPath, "#!/bin/sh\nprintf '%s' 'test-copilot-token'\n");
  await chmod(ghPath, 0o755);
  await writeFile(preloadPath, `
    globalThis.fetch = async (_url, options) => {
      if (options.headers.authorization !== "token test-copilot-token") throw new Error("missing auth");
      return new Response(JSON.stringify({ quota_reset_date_utc: "2030-01-01T00:00:00.000Z", quota_snapshots: {
        premium_interactions: { percent_remaining: 75, quota_reset_at: 0 },
        chat: { remaining: 2, entitlement: 8, quota_reset_at: 1900000000 },
        future_bucket: { remaining: 1, entitlement: 4 },
        unlimited_bucket: { remaining: 1, entitlement: 4, unlimited: true },
        zero_bucket: { remaining: 1, entitlement: 0 },
        negative_remaining: { remaining: -1, entitlement: 4 },
        excessive_remaining: { remaining: 5, entitlement: 4 },
        negative_percent: { percent_remaining: -1 },
        excessive_percent: { percent_remaining: 101 },
        malformed_bucket: { percent_remaining: "50" }
      } }));
    };
  `);
  try {
    const result = spawnSync(process.execPath, ["--import", preloadPath, "scripts/collect.mjs"], {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      encoding: "utf8",
      env: isolatedEnv(directory, { GH_BIN_PATH: ghPath }),
    });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.deepEqual(snapshot.providers.copilot.windows.map(({ label, usedPercent, resetsAt }) =>
      ({ label, usedPercent, resetsAt })), [
      { label: "Premium", usedPercent: 25, resetsAt: Date.parse("2030-01-01T00:00:00Z") },
      { label: "Chat", usedPercent: 75, resetsAt: 1900000000000 },
      { label: "future bucket", usedPercent: 75, resetsAt: Date.parse("2030-01-01T00:00:00Z") },
    ]);
    const cache = await readFile(cachePath, "utf8");
    assert.doesNotMatch(cache, /test-copilot-token|Bearer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot rejects oversized gh token output without exposing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-copilot-output-test-"));
  const cachePath = join(directory, "cache.json");
  const ghPath = join(directory, "gh");
  await writeFile(ghPath, "#!/bin/sh\nprintf '%17000s' 'secret-token'\n");
  await chmod(ghPath, 0o755);
  try {
    const result = spawnSync(process.execPath, ["scripts/collect.mjs"], {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      encoding: "utf8",
      env: isolatedEnv(directory, { GH_BIN_PATH: ghPath }),
    });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.errors.copilot, "GitHub CLI token output exceeded the size limit");
    assert.doesNotMatch(result.stdout, /secret-token|Bearer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot times out a hung gh token command with a safe error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-copilot-timeout-test-"));
  const cachePath = join(directory, "cache.json");
  const ghPath = join(directory, "gh");
  await writeFile(ghPath, "#!/bin/sh\nexec sleep 30\n");
  await chmod(ghPath, 0o755);
  try {
    const result = spawnSync(process.execPath, ["scripts/collect.mjs"], {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      encoding: "utf8",
      env: isolatedEnv(directory, { GH_BIN_PATH: ghPath }),
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.errors.copilot, "GitHub CLI token command timed out");
    assert.doesNotMatch(result.stdout, /Bearer|sleep 30/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
