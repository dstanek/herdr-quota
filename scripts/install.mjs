import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
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

await mkdir(dirname(modHome), { recursive: true });
try {
  await access(modHome);
  fail(`Refusing to overwrite existing mod at ${modHome}`);
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

await cp(join(root, "mods", "quota"), modHome, { recursive: true });
await cp(join(root, "scripts", "collect.mjs"), join(modHome, "collect.mjs"));
await cp(join(root, "scripts", "claude-credentials.mjs"), join(modHome, "claude-credentials.mjs"));
const usage = {
  id: "quota",
  type: "block",
  size: { px: 220 },
  min: 110,
  content: { mod: "quota" },
};
column.children.splice(column.children.indexOf(agents) + 1, 0, usage);
await writeFile(newLayoutPath, `${JSON.stringify(layout, null, 2)}\n`, { flag: "wx" });
console.log(`Installed the quota mod at ${modHome}`);
console.log(`Created ${newLayoutPath}. Switch to it with: herdr-app do layout.switch '{"name":"quota-main"}'`);
