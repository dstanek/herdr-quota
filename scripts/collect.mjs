import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { readClaudeCredentials } from "./claude-credentials.mjs";

const home = homedir();
const errors = {};
const absent = {};
const providers = {};
const cachePath = process.env.HERDR_USAGE_CACHE
  || join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "herdr-usage.json");
const cache = await readJson(cachePath) || { providers: {}, retryAfter: {} };
if (!cache.providers || typeof cache.providers !== "object") cache.providers = {};
if (!cache.retryAfter || typeof cache.retryAfter !== "object") cache.retryAfter = {};

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function dateMs(value) {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeWindow(label, usedPercent, resetsAt) {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
  return { label, usedPercent: Math.max(0, Math.min(100, usedPercent)), resetsAt: dateMs(resetsAt) };
}

function retryAfterMs(response) {
  const header = response.headers.get("retry-after");
  const seconds = Number(header);
  const retryDate = Date.parse(header);
  return Number.isFinite(seconds) && seconds > 0
    ? Date.now() + seconds * 1000
    : Number.isFinite(retryDate) && retryDate > Date.now()
      ? retryDate
      : Date.now() + 10 * 60 * 1000;
}

// Read once per run: on macOS every read spawns a Keychain lookup.
let claudeSignIn;
function claudeCredentials() {
  claudeSignIn ??= readClaudeCredentials({
    configDir: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    securityCommand: process.env.CLAUDE_SECURITY_COMMAND || "security",
  });
  return claudeSignIn;
}

// collectProvider has already turned away an expired sign-in.
async function claude() {
  const token = (await claudeCredentials())?.claudeAiOauth?.accessToken;
  if (!token) throw new Error("No Claude Code sign-in found");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "claude-cli/2.1.278 (external, cli)",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const reason = response.status === 401 ? "Claude sign-in expired; run claude to refresh it"
        : response.status === 429 ? "Usage endpoint is rate limited"
          : `Usage endpoint returned ${response.status}`;
      const error = new Error(reason);
      if (response.status === 429) error.retryAfter = retryAfterMs(response);
      throw error;
    }
    const body = await response.json();
    const windows = [];
    for (const item of body.limits || []) {
      const title = item.kind === "session" ? "5h" : item.kind === "weekly_all" ? "7d"
        : item.kind === "weekly_scoped" ? `7d ${item.scope?.model?.display_name || "model"}` : item.kind;
      const window = normalizeWindow(title, item.percent, item.resets_at);
      if (window) windows.push(window);
    }
    if (!windows.length) {
      for (const [key, item] of Object.entries(body)) {
        if (item && typeof item === "object" && typeof item.utilization === "number") {
          const window = normalizeWindow(key.replaceAll("_", " "), item.utilization, item.resets_at);
          if (window) windows.push(window);
        }
      }
    }
    if (!windows.length) throw new Error("No quota windows returned");
    return { windows };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Usage request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function codexRpc() {
  const executable = process.env.CODEX_BIN_PATH || "codex";
  const child = spawn(executable, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    shell: process.platform === "win32",
  });
  let buffer = "";
  const waiting = new Map();
  const failWaiting = (error) => {
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
  };
  const timeout = setTimeout(() => {
    failWaiting(new Error("Codex app-server timed out"));
    child.kill();
  }, 20000);
  child.on("error", failWaiting);
  child.stdin.on("error", failWaiting);
  child.on("exit", (code) => {
    if (waiting.size) failWaiting(new Error(`Codex app-server exited (${code ?? "unknown status"})`));
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        const pending = waiting.get(message.id);
        if (pending) {
          waiting.delete(message.id);
          pending.resolve(message);
        }
      } catch {}
    }
  });
  const request = (id, method, params = {}) => new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
      if (error) {
        waiting.delete(id);
        reject(error);
      }
    });
  });
  const sendNotification = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  try {
    const initialized = await request(1, "initialize", {
      clientInfo: { name: "herdr-quota", version: "0.1.0" },
      capabilities: {},
    });
    if (initialized.error) throw new Error(String(initialized.error.message || "Codex initialization failed"));
    sendNotification("initialized");
    const accountResponse = await request(2, "account/read");
    if (accountResponse.error) throw new Error(String(accountResponse.error.message || "Codex account request failed"));
    const account = accountResponse.result?.account;
    if (account?.type && account.type !== "chatgpt") throw new Error("Codex is using API-key auth, not a ChatGPT subscription");
    const limitsResponse = await request(3, "account/rateLimits/read");
    if (limitsResponse.error) throw new Error(String(limitsResponse.error.message || "Codex usage request failed"));
    return { account, resultData: limitsResponse.result };
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

async function codex() {
  const { account, resultData } = await codexRpc();
  const main = resultData?.rateLimits || resultData?.rate_limits;
  const byId = resultData?.rateLimitsByLimitId || resultData?.rate_limits_by_limit_id || {};
  const windows = [];
  const add = (limit, name = "") => {
    for (const field of ["primary", "secondary"]) {
      const item = limit?.[field];
      if (typeof item?.usedPercent !== "number") continue;
      const mins = item.windowDurationMins;
      const span = !Number.isFinite(mins) ? field
        : mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
      windows.push(normalizeWindow(`${span}${name ? ` ${name}` : ""}`, item.usedPercent, item.resetsAt));
    }
  };
  add(main);
  const mainId = main?.limitId || main?.limit_id;
  for (const [id, limit] of Object.entries(byId)) {
    if (id !== mainId) add(limit, limit.limitName || limit.limit_name || id);
  }
  if (!windows.length) throw new Error("No ChatGPT plan windows returned");
  return { plan: resultData?.rateLimits?.planType || account?.planType || null, windows };
}

async function copilot() {
  const executable = process.env.GH_BIN_PATH || "gh";
  const token = await new Promise((resolve, reject) => {
    let child;
    let output = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      child?.kill();
      finish(new Error("GitHub CLI token command timed out"));
    }, 5000);
    try {
      child = spawn(executable, ["auth", "token"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: process.platform === "win32",
      });
    } catch {
      finish(new Error("GitHub CLI sign-in not found; run gh auth login"));
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 16384) {
        child.kill();
        finish(new Error("GitHub CLI token output exceeded the size limit"));
        return;
      }
      output += chunk;
    });
    child.on("error", () => finish(new Error("GitHub CLI sign-in not found; run gh auth login")));
    child.on("exit", (code) => {
      if (code !== 0) finish(new Error("GitHub CLI sign-in not found; run gh auth login"));
      else finish(null, output.trim());
    });
  });
  if (!token) throw new Error("GitHub CLI sign-in not found; run gh auth login");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("https://api.github.com/copilot_internal/user", {
      headers: {
        authorization: `token ${token}`,
        accept: "application/json",
        "editor-version": "vscode/1.99.3",
        "editor-plugin-version": "copilot-chat/0.26.7",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      // GitHub signals rate limits with 429, or 403 carrying retry-after.
      const limited = response.status === 429 || (response.status === 403 && response.headers.has("retry-after"));
      const error = new Error(limited ? "Copilot usage endpoint is rate limited"
        : `Copilot usage endpoint returned ${response.status}`);
      if (limited) error.retryAfter = retryAfterMs(response);
      throw error;
    }
    const body = await response.json();
    const snapshots = body?.quota_snapshots;
    if (!snapshots || typeof snapshots !== "object" || Array.isArray(snapshots)) {
      throw new Error("No Copilot quota snapshots returned");
    }
    const labels = { premium_interactions: "Premium", chat: "Chat", completions: "Completions" };
    const windows = [];
    for (const [key, item] of Object.entries(snapshots)) {
      if (!item || typeof item !== "object" || item.unlimited === true) continue;
      let remainingPercent;
      if (typeof item.percent_remaining === "number" && Number.isFinite(item.percent_remaining)
        && item.percent_remaining >= 0 && item.percent_remaining <= 100) {
        remainingPercent = item.percent_remaining;
      } else if (typeof item.remaining === "number" && Number.isFinite(item.remaining)
        && typeof item.entitlement === "number" && Number.isFinite(item.entitlement) && item.entitlement > 0
        && item.remaining >= 0 && item.remaining <= item.entitlement) {
        remainingPercent = item.remaining / item.entitlement * 100;
      } else continue;
      const resetsAt = item.quota_reset_at || body.quota_reset_date_utc || body.quota_reset_date;
      const window = normalizeWindow(labels[key] || key.replaceAll("_", " "), 100 - remainingPercent, resetsAt);
      if (window) windows.push(window);
    }
    if (!windows.length) throw new Error("No finite Copilot quota windows returned");
    return { windows };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Copilot usage request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function persistCache() {
  await mkdir(dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
  await rename(temporary, cachePath);
}

function visibleWindows(snapshot) {
  const now = Date.now();
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  return windows.filter((window) => window && (!window.resetsAt || window.resetsAt > now));
}

async function collectProvider(id, load) {
  const now = Date.now();
  const previous = cache.providers[id];
  const oldWindows = visibleWindows(previous);
  const cooldownUntil = cache.retryAfter[id] || 0;

  if (id === "claude") {
    const credentials = await claudeCredentials();
    const expiresAt = credentials?.claudeAiOauth?.expiresAt;
    const expiresMs = dateMs(expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= now) {
      delete cache.retryAfter[id];
      errors[id] = "Claude sign-in expired; run claude to refresh it";
      if (oldWindows.length) providers[id] = { ...previous, windows: oldWindows, stale: true, note: errors[id] };
      return;
    }
  }

  if (cooldownUntil > now) {
    errors[id] = `Rate limited; retry in ${Math.ceil((cooldownUntil - now) / 60000)}m`;
    if (oldWindows.length) providers[id] = { ...previous, windows: oldWindows, stale: true };
    return;
  }
  if (previous?.fetchedAt && now - previous.fetchedAt < 60_000 && oldWindows.length) {
    providers[id] = { ...previous, windows: oldWindows };
    return;
  }

  try {
    const fresh = await load();
    const snapshot = { ...fresh, fetchedAt: Date.now() };
    cache.providers[id] = snapshot;
    delete cache.retryAfter[id];
    providers[id] = snapshot;
  } catch (error) {
    const message = id === "chatgpt" && /ENOENT|not found|not recognized/i.test(String(error.message))
      ? "Codex CLI not found; sign in with ChatGPT in Codex"
      : String(error.message || error);
    errors[id] = message;
    // Never set up, as opposed to broken: the panel shows these quietly.
    if (/CLI not found|sign-in (not )?found/.test(message)) absent[id] = true;
    if (error.retryAfter) cache.retryAfter[id] = error.retryAfter;
    if (oldWindows.length && Number.isFinite(previous?.fetchedAt)) {
      providers[id] = { ...previous, windows: oldWindows, stale: true, note: message };
    }
  }
}

await Promise.all([
  collectProvider("claude", claude),
  collectProvider("chatgpt", codex),
  collectProvider("copilot", copilot),
]);
try {
  await persistCache();
} catch {
  // Current readings remain usable if the cache directory is unavailable.
}
process.stdout.write(JSON.stringify({ providers, errors, absent }));
