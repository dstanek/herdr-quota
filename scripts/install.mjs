import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
const modHome = join(appHome, "mods", "quota");
const layoutPath = join(appHome, "layouts", "main.json");
const newLayoutPath = join(appHome, "layouts", "quota-main.json");

await mkdir(dirname(modHome), { recursive: true });
try {
  await access(modHome);
  throw new Error(`Refusing to overwrite existing mod at ${modHome}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(dirname(newLayoutPath), { recursive: true });

let layout;
try {
  layout = JSON.parse(await readFile(layoutPath, "utf8"));
} catch {
  throw new Error(`Could not read the installed main layout at ${layoutPath}`);
}
try {
  await readFile(newLayoutPath, "utf8");
  throw new Error(`Refusing to overwrite ${newLayoutPath}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children || []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

const agents = findNode(layout, "agents");
if (!agents || !agents.content) throw new Error("The main layout does not contain the expected Agents block");
const sidebarLists = findNode(layout, "sidebar-lists") || findNode(layout, "sidebar");
if (!sidebarLists || !Array.isArray(sidebarLists.children)) throw new Error("Could not locate the sidebar layout column");

await cp(join(root, "mods", "quota"), modHome, { recursive: true });
await cp(join(root, "scripts", "collect.mjs"), join(modHome, "collect.mjs"));
await cp(join(root, "scripts", "claude-credentials.mjs"), join(modHome, "claude-credentials.mjs"));
const usage = {
  id: "quota",
  type: "block",
  size: { px: 220 },
  min: 110,
  content: { mod: "quota", props: { collector: join(modHome, "collect.mjs") } },
};
sidebarLists.children.splice(sidebarLists.children.indexOf(agents) + 1, 0, usage);
await writeFile(newLayoutPath, `${JSON.stringify(layout, null, 2)}\n`, { flag: "wx" });
console.log(`Installed the quota mod at ${modHome}`);
console.log(`Created ${newLayoutPath}. Switch to it with: herdr-app do layout.switch '{"name":"quota-main"}'`);
