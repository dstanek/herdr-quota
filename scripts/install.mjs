import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
const modHome = join(appHome, "mods", "quota");
const layoutPath = join(appHome, "layouts", "main.json");
const newLayoutPath = join(appHome, "layouts", "quota-main.json");

// Expected problems get a plain message; anything else still throws with its stack.
function fail(message) {
  console.error(message);
  process.exit(1);
}

async function copyMod() {
  await cp(join(root, "mods", "quota"), modHome, { recursive: true });
  await cp(join(root, "scripts", "collect.mjs"), join(modHome, "collect.mjs"));
  await cp(join(root, "scripts", "claude-credentials.mjs"), join(modHome, "claude-credentials.mjs"));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// collect.mjs is the one file only this mod installs, so its absence means another mod has the name.
async function refuseForeignMod() {
  if (await exists(modHome) && !await exists(join(modHome, "collect.mjs"))) {
    fail(`${modHome} is not the quota mod this installer manages (it has no collect.mjs). Leaving it alone.`);
  }
}

// Herdr must not be left showing the layout that is about to be deleted.
function leaveGeneratedLayout() {
  const herdr = process.env.HERDR_APP_BIN_PATH || "herdr-app";
  let shown;
  try {
    shown = JSON.parse(spawnSync(herdr, ["status"], { encoding: "utf8", timeout: 5000 }).stdout).layout;
  } catch {
    // Not installed or not running: nothing is showing the layout.
    return false;
  }
  if (shown !== "quota-main") return false;
  const switched = spawnSync(herdr, ["do", "layout.switch", JSON.stringify({ name: "main" })], { timeout: 5000 });
  if (switched.status !== 0) {
    fail("Herdr is showing quota-main and could not be switched to main. Switch layouts, then run --uninstall again.");
  }
  return true;
}

const mode = process.argv[2];
if (mode === "--upgrade") {
  if (!await exists(modHome)) fail(`Nothing to upgrade at ${modHome}. Run without --upgrade to install.`);
  await refuseForeignMod();
  await copyMod();
  console.log(`Upgraded the quota mod at ${modHome}. Layouts were left as they are.`);
  process.exit(0);
} else if (mode === "--uninstall") {
  await refuseForeignMod();
  const switched = leaveGeneratedLayout();
  await rm(modHome, { recursive: true, force: true });
  await rm(newLayoutPath, { force: true });
  console.log(`Removed ${modHome} and ${newLayoutPath}`);
  if (switched) console.log("Herdr was showing quota-main, so it was switched to main first.");
  process.exit(0);
} else if (mode) {
  fail("Usage: node scripts/install.mjs [--upgrade | --uninstall]");
}

await mkdir(dirname(modHome), { recursive: true });
try {
  await access(modHome);
  fail(`Refusing to overwrite existing mod at ${modHome}. Use --upgrade to update it.`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(dirname(newLayoutPath), { recursive: true });

let layout;
try {
  layout = JSON.parse(await readFile(layoutPath, "utf8"));
} catch {
  fail(`Could not read the installed main layout at ${layoutPath}`);
}
try {
  await readFile(newLayoutPath, "utf8");
  fail(`Refusing to overwrite ${newLayoutPath}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function findParent(node, id) {
  for (const child of node?.children || []) {
    if (child?.id === id) return node;
    const found = findParent(child, id);
    if (found) return found;
  }
  return null;
}

const column = findParent(layout, "agents");
const agents = column?.children.find((child) => child?.id === "agents");
if (!agents || !agents.content) fail("The main layout does not contain the expected Agents block");
if (column.type !== "column") fail("The Agents block is not in a column, so Quota cannot be placed beneath it");

await copyMod();
const quota = {
  id: "quota",
  type: "block",
  size: { px: 220 },
  min: 110,
  content: { mod: "quota" },
};
column.children.splice(column.children.indexOf(agents) + 1, 0, quota);
await writeFile(newLayoutPath, `${JSON.stringify(layout, null, 2)}\n`, { flag: "wx" });
console.log(`Installed the quota mod at ${modHome}`);
console.log(`Created ${newLayoutPath}. Switch to it with: herdr-app do layout.switch '{"name":"quota-main"}'`);
