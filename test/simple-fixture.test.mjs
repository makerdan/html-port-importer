import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { temporaryDirectory } from "../lib/core.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function setupSimpleImporter() {
  const root = await temporaryDirectory("simple-importer-test-");
  await fs.mkdir(path.join(root, "lib"), { recursive: true });
  await fs.mkdir(path.join(root, "fixtures"), { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(repositoryRoot, "import.mjs"), path.join(root, "import.mjs")),
    fs.copyFile(path.join(repositoryRoot, "verify.mjs"), path.join(root, "verify.mjs")),
    fs.copyFile(path.join(repositoryRoot, "lib", "core.mjs"), path.join(root, "lib", "core.mjs")),
    fs.copyFile(path.join(repositoryRoot, "lib", "simple-fixture.mjs"), path.join(root, "lib", "simple-fixture.mjs")),
    ...["index.html", "style.css", "app.js", "manifest.json"].map((name) =>
      fs.copyFile(path.join(repositoryRoot, "fixtures", name), path.join(root, "fixtures", name))),
  ]);
  return root;
}

async function run(root, command) {
  return execFileAsync(process.execPath, [path.join(root, command)], { cwd: root });
}

test("simple importer copies exact fixture files, verifies, and changes nothing outside imported-app", async () => {
  const root = await setupSimpleImporter();
  try {
    const sentinel = path.join(root, "outside-sentinel.txt");
    await fs.writeFile(sentinel, "unchanged");
    const siblingEvents = [];
    const watcher = fsSync.watch(root, (_event, filename) => {
      if (filename && filename !== "imported-app") siblingEvents.push(filename);
    });
    const imported = await run(root, "import.mjs");
    watcher.close();
    assert.match(imported.stdout, /^PASS:/);
    for (const name of ["index.html", "style.css", "app.js"]) {
      assert.deepEqual(
        await fs.readFile(path.join(root, "imported-app", name)),
        await fs.readFile(path.join(root, "fixtures", name)),
      );
    }
    assert.equal(await fs.readFile(sentinel, "utf8"), "unchanged");
    assert.deepEqual(siblingEvents, []);
    const verified = await run(root, "verify.mjs");
    assert.match(verified.stdout, /^PASS:/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("simple importer leaves correct files unchanged on a second run", async () => {
  const root = await setupSimpleImporter();
  try {
    await run(root, "import.mjs");
    const target = path.join(root, "imported-app", "index.html");
    const before = await fs.stat(target);
    const repeated = await run(root, "import.mjs");
    const after = await fs.stat(target);
    assert.match(repeated.stdout, /already matches/);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("simple importer rejects a fixture with the wrong hash", async () => {
  const root = await setupSimpleImporter();
  try {
    await fs.appendFile(path.join(root, "fixtures", "app.js"), "\nchanged");
    await assert.rejects(run(root, "import.mjs"), (error) => {
      assert.match(error.stderr, /^FAIL: HASH_MISMATCH:/);
      return true;
    });
    await assert.rejects(fs.stat(path.join(root, "imported-app")), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("simple verifier rejects a missing imported file", async () => {
  const root = await setupSimpleImporter();
  try {
    await run(root, "import.mjs");
    await fs.rm(path.join(root, "imported-app", "style.css"));
    await assert.rejects(run(root, "verify.mjs"), (error) => {
      assert.match(error.stderr, /^FAIL: VERIFY_FAILED: Missing file: style\.css/);
      return true;
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("simple importer rejects traversal without changing an outside file", async () => {
  const root = await setupSimpleImporter();
  try {
    const outside = path.join(root, "secret.txt");
    await fs.writeFile(outside, "keep");
    const manifestPath = path.join(root, "fixtures", "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.files.push({
      path: "../secret.txt",
      bytes: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(run(root, "import.mjs"), (error) => {
      assert.match(error.stderr, /^FAIL: INVALID_INPUT: File path contains traversal/);
      return true;
    });
    assert.equal(await fs.readFile(outside, "utf8"), "keep");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});