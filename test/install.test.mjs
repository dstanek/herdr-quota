import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  return spawnSync(process.execPath, ["scripts/install.mjs", ...args], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    encoding: "utf8",
    env: { ...process.env, HERDR_APP_HOME: appHome },
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
