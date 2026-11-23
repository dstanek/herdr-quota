import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

// Only what the collector uses: the refresh token and anything else stored beside it stay here.
function pick(stored) {
  const oauth = stored?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;
  const { accessToken, expiresAt, subscriptionType } = oauth;
  return { claudeAiOauth: { accessToken, expiresAt, subscriptionType } };
}

function readKeychain(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    const timeout = setTimeout(() => child.kill(), 3000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 1024 * 1024) {
        child.kill();
        reject(new Error("Claude Keychain item is unexpectedly large"));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      // 44: no such item, the normal state for an install that uses the credential file.
      if (code === 44) return resolve(null);
      if (code !== 0) return reject(new Error("Claude Keychain credentials unavailable"));
      try {
        resolve(pick(JSON.parse(output.trim())));
      } catch {
        reject(new Error("Claude Keychain credentials are not valid JSON"));
      }
    });
  });
}

export async function readClaudeCredentials({
  platform = process.platform,
  configDir,
  securityCommand = "/usr/bin/security",
} = {}) {
  let keychainUnavailable = false;
  if (platform === "darwin") {
    try {
      const keychain = await readKeychain(securityCommand);
      if (keychain?.claudeAiOauth?.accessToken) return keychain;
    } catch {
      // Older installs and headless environments may still use the credential file.
      keychainUnavailable = true;
    }
  }

  try {
    const file = pick(JSON.parse(await readFile(join(configDir, ".credentials.json"), "utf8")));
    // Lets the caller tell a leftover file apart from the sign-in Keychain would have given.
    return file && keychainUnavailable ? { ...file, keychainUnavailable } : file;
  } catch {
    return null;
  }
}
