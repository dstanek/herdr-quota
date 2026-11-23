import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mainLayout = {
  id: "root",
  type: "row",
  children: [{
    id: "sidebar",
    type: "column",
    children: [{
      id: "sidebar-lists",
      type: "column",
      children: [
        { id: "spaces", type: "block", content: { mod: "spaces" } },
        { id: "agents", type: "block", content: { mod: "agents" } },
      ],
    }],
  }],
};

function install(appHome, ...args) {
  const env = typeof args.at(-1) === "object" ? args.pop() : {};
  return spawnSync(process.execPath, ["scripts/install.mjs", ...args], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    encoding: "utf8",
    env: { ...process.env, HERDR_APP_BIN_PATH: join(appHome, "missing-herdr-app"), ...env, HERDR_APP_HOME: appHome },
  });
}

test("installer copies the mod and adds Quota beneath Agents in a new layout", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "herdr-install-test-"));
  const mainPath = join(appHome, "layouts", "main.json");
  await mkdir(dirname(mainPath));
  await writeFile(mainPath, JSON.stringify(mainLayout));
  try {
    const result = install(appHome);
    assert.equal(result.status, 0, result.stderr);
    const installed = await readdir(join(appHome, "mods", "quota"));
    for (const file of ["main.js", "mod.json", "collect.mjs", "claude-credentials.mjs"]) {
      assert.ok(installed.includes(file), `${file} was not installed`);
    }
    const layout = JSON.parse(await readFile(join(appHome, "layouts", "quota-main.json"), "utf8"));
    const lists = layout.children[0].children[0].children;
    assert.deepEqual(lists.map((node) => node.id), ["spaces", "agents", "quota"]);
    assert.deepEqual(lists[2].content, { mod: "quota" });
    assert.deepEqual(JSON.parse(await readFile(mainPath, "utf8")), mainLayout);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("installer places Quota beneath Agents wherever the Agents block sits", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "herdr-install-nested-test-"));
  const mainPath = join(appHome, "layouts", "main.json");
  await mkdir(dirname(mainPath));
  await writeFile(mainPath, JSON.stringify({
    id: "root",
    type: "row",
    children: [{
      id: "sidebar",
      type: "column",
      children: [
        { id: "brand", type: "block", content: { mod: "workspace-chrome" } },
        { id: "lists", type: "column", children: [{ id: "agents", type: "block", content: { mod: "agents" } }] },
      ],
    }],
  }));
  try {
    const result = install(appHome);
    assert.equal(result.status, 0, result.stderr);
    const layout = JSON.parse(await readFile(join(appHome, "layouts", "quota-main.json"), "utf8"));
    const [brand, lists] = layout.children[0].children;
    assert.equal(brand.id, "brand");
    assert.deepEqual(lists.children.map((node) => node.id), ["agents", "quota"]);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("installer refuses a layout whose Agents block is not in a column", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "herdr-install-row-test-"));
  const mainPath = join(appHome, "layouts", "main.json");
  await mkdir(dirname(mainPath));
  await writeFile(mainPath, JSON.stringify({
    id: "root",
    type: "row",
    children: [{ id: "agents", type: "block", content: { mod: "agents" } }],
  }));
  try {
    const result = install(appHome);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not in a column/);
    assert.deepEqual(await readdir(join(appHome, "mods")), []);
    assert.deepEqual(await readdir(join(appHome, "layouts")), ["main.json"]);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("installer refuses to overwrite an existing install", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "herdr-install-again-test-"));
  const mainPath = join(appHome, "layouts", "main.json");
  const layoutPath = join(appHome, "layouts", "quota-main.json");
  await mkdir(dirname(mainPath));
  await writeFile(mainPath, JSON.stringify(mainLayout));
  try {
    assert.equal(install(appHome).status, 0);
    const before = await readFile(layoutPath, "utf8");
    const again = install(appHome);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /^Refusing to overwrite existing mod at .*\n$/);
    assert.equal(await readFile(layoutPath, "utf8"), before);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("--upgrade replaces the mod files and leaves the layout alone", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "herdr-install-upgrade-test-"));
  const mainPath = join(appHome, "layouts", "main.json");
  const layoutPath = join(appHome, "layouts", "quota-main.json");
  const collectorPath = join(appHome, "mods", "quota", "collect.mjs");
  await mkdir(dirname(mainPath));
  await writeFile(mainPath, JSON.stringify(mainLayout));
  try {
    const missing = install(appHome, "--upgrade");
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /^Nothing to upgrade/);
    assert.equal(install(appHome).status, 0);
    await writeFile(collectorPath, "old");
    await writeFile(layoutPath, "edited by hand");
    const result = install(appHome, "--upgrade");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(collectorPath, "utf8"),
      await readFile(new URL("../scripts/collect.mjs", import.meta.url), "utf8"),
    );
    assert.equal(await readFile(layoutPath, "utf8"), "edited by hand");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("--uninstall removes the mod and the generated layout only", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "herdr-install-uninstall-test-"));
  const mainPath = join(appHome, "layouts", "main.json");
  await mkdir(dirname(mainPath));
  await mkdir(join(appHome, "mods", "agents"), { recursive: true });
  await writeFile(mainPath, JSON.stringify(mainLayout));
  try {
    assert.equal(install(appHome).status, 0);
    const result = install(appHome, "--uninstall");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readdir(join(appHome, "mods")), ["agents"]);
    assert.deepEqual(await readdir(join(appHome, "layouts")), ["main.json"]);
    assert.equal(install(appHome, "--uninstall").status, 0);
    assert.notEqual(install(appHome, "--bogus").status, 0);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("--uninstall switches Herdr away from the generated layout before deleting it", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "herdr-install-switch-test-"));
  const mainPath = join(appHome, "layouts", "main.json");
  const herdr = join(appHome, "herdr-app");
  const calls = join(appHome, "calls");
  await mkdir(dirname(mainPath));
  await writeFile(mainPath, JSON.stringify(mainLayout));
  // A stand-in herdr-app: logs its arguments, reports $SHOWN as the shown layout, and exits $SWITCH on a switch.
  await writeFile(herdr, `#!/bin/sh
echo "$@" >> '${calls}'
if [ "$1" = status ]; then echo "{\\"layout\\": \\"$SHOWN\\"}"; exit 0; fi
exit "$SWITCH"
`);
  await chmod(herdr, 0o755);
  const uninstall = (shown, switchStatus) => install(appHome, "--uninstall", {
    HERDR_APP_BIN_PATH: herdr, SHOWN: shown, SWITCH: String(switchStatus),
  });
  try {
    assert.equal(install(appHome).status, 0);
    const refused = uninstall("quota-main", 1);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /could not be switched to main/);
    assert.deepEqual(await readdir(join(appHome, "layouts")), ["main.json", "quota-main.json"]);

    await rm(calls);
    const result = uninstall("quota-main", 0);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(calls, "utf8"), 'status\ndo layout.switch {"name":"main"}\n');
    assert.deepEqual(await readdir(join(appHome, "layouts")), ["main.json"]);

    assert.equal(install(appHome).status, 0);
    await rm(calls);
    assert.equal(uninstall("terminals", 0).status, 0);
    assert.equal(await readFile(calls, "utf8"), "status\n");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("--upgrade and --uninstall leave another mod named quota alone", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "herdr-install-foreign-test-"));
  const foreign = join(appHome, "mods", "quota", "main.js");
  const layoutPath = join(appHome, "layouts", "quota-main.json");
  await mkdir(dirname(foreign), { recursive: true });
  await mkdir(dirname(layoutPath));
  await writeFile(foreign, "someone else's mod");
  await writeFile(layoutPath, "someone else's layout");
  try {
    for (const flag of ["--upgrade", "--uninstall"]) {
      const result = install(appHome, flag);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /is not the quota mod this installer manages/);
      assert.deepEqual(await readdir(dirname(foreign)), ["main.js"]);
      assert.equal(await readFile(foreign, "utf8"), "someone else's mod");
      assert.equal(await readFile(layoutPath, "utf8"), "someone else's layout");
    }
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("installer leaves nothing behind when the main layout has no Agents block", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "herdr-install-layout-test-"));
  const mainPath = join(appHome, "layouts", "main.json");
  await mkdir(dirname(mainPath));
  await writeFile(mainPath, JSON.stringify({ id: "root", type: "row", children: [] }));
  try {
    const result = install(appHome);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not contain the expected Agents block/);
    assert.deepEqual(await readdir(join(appHome, "mods")), []);
    assert.deepEqual(await readdir(join(appHome, "layouts")), ["main.json"]);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});
