import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import {
  createStaticServer, downloadHttps, importBundle, LIMITS, parseBundle, parseManifest, readInput,
  sha256, temporaryDirectory, verifyDirectory,
} from "../lib/core.mjs";

const fixtureBundle = await fs.readFile(new URL("../fixtures/hello/bundle.json", import.meta.url));
const fixtureManifest = await fs.readFile(new URL("../fixtures/hello/manifest.json", import.meta.url)).catch(() => null);
const execFileAsync = promisify(execFile);

function documents(files = [
  ["index.html", Buffer.from("<h1>Exact import test</h1>")],
  ["assets/style.css", Buffer.from("body{}")],
  ["assets/app.js", Buffer.from("void 0;")],
], entrypoint = "index.html") {
  const bundle = {
    version: 1, entrypoint,
    files: files.map(([filePath, bytes]) => ({ path: filePath, base64: bytes.toString("base64") })),
  };
  const bundleBytes = Buffer.from(JSON.stringify(bundle));
  const manifest = {
    version: 1, bundleSha256: sha256(bundleBytes), entrypoint,
    files: files.map(([filePath, bytes]) => ({ path: filePath, bytes: bytes.length, sha256: sha256(bytes) })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return { bundleBytes, manifestBytes, manifestHash: sha256(manifestBytes), manifest };
}

async function setup() {
  const root = await temporaryDirectory();
  return { root, dest: path.join(root, "site"), ...documents() };
}

test("fixture is internally valid", () => {
  assert.ok(fixtureManifest);
  const manifest = parseManifest(fixtureManifest, sha256(fixtureManifest));
  assert.equal(parseBundle(fixtureBundle, manifest).length, 3);
});

test("successful exact import and identical repeat import", async () => {
  const value = await setup();
  try {
    const first = await importBundle({ ...value, expectedManifestHash: value.manifestHash, destination: value.dest });
    assert.equal(first.unchanged, false);
    const before = (await fs.stat(path.join(value.dest, "index.html"))).mtimeMs;
    const second = await importBundle({ ...value, expectedManifestHash: value.manifestHash, destination: value.dest });
    assert.equal(second.unchanged, true);
    assert.equal((await fs.stat(path.join(value.dest, "index.html"))).mtimeMs, before);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

for (const [name, mutate, pattern] of [
  ["modified file", (d) => fs.writeFile(path.join(d, "index.html"), "changed"), /Changed file/],
  ["missing file", (d) => fs.rm(path.join(d, "index.html")), /Missing file/],
  ["extra file", (d) => fs.writeFile(path.join(d, "extra.txt"), "extra"), /Extra file/],
]) {
  test(`verification rejects ${name}`, async () => {
    const value = await setup();
    try {
      await importBundle({ ...value, expectedManifestHash: value.manifestHash, destination: value.dest });
      await mutate(value.dest);
      await assert.rejects(verifyDirectory(value.dest, value.manifest), pattern);
    } finally { await fs.rm(value.root, { recursive: true, force: true }); }
  });
}

test("wrong manifest hash is rejected", () => {
  const value = documents();
  assert.throws(() => parseManifest(value.manifestBytes, "0".repeat(64)), /Manifest SHA-256/);
});

test("wrong bundle hash is rejected", () => {
  const value = documents();
  const manifest = { ...value.manifest, bundleSha256: "0".repeat(64) };
  assert.throws(() => parseBundle(value.bundleBytes, manifest), /Bundle SHA-256/);
});

test("bundle and manifest entrypoint disagreement is rejected", () => {
  const value = documents();
  const bundle = JSON.parse(value.bundleBytes);
  bundle.entrypoint = "assets/app.js";
  const bytes = Buffer.from(JSON.stringify(bundle));
  const manifest = { ...value.manifest, bundleSha256: sha256(bytes) };
  assert.throws(() => parseBundle(bytes, manifest), /disagrees/);
});

test("invalid base64 is rejected", () => {
  const value = documents();
  const bundle = JSON.parse(value.bundleBytes);
  bundle.files[0].base64 = "!!!!";
  const bytes = Buffer.from(JSON.stringify(bundle));
  const manifest = { ...value.manifest, bundleSha256: sha256(bytes) };
  assert.throws(() => parseBundle(bytes, manifest), /base64/);
});

test("traversal is rejected", () => {
  const value = documents([["../escape.html", Buffer.from("x")] ], "../escape.html");
  assert.throws(() => parseManifest(value.manifestBytes, value.manifestHash), /traversal/);
});

test("duplicate and case-colliding paths are rejected", () => {
  for (const files of [
    [["index.html", Buffer.from("a")], ["index.html", Buffer.from("b")]],
    [["index.html", Buffer.from("a")], ["INDEX.HTML", Buffer.from("b")]],
  ]) {
    const value = documents(files);
    assert.throws(() => parseManifest(value.manifestBytes, value.manifestHash), /duplicate|case-colliding/);
  }
});

test("symlink is rejected", async (t) => {
  const value = await setup();
  try {
    await importBundle({ ...value, expectedManifestHash: value.manifestHash, destination: value.dest });
    await fs.rm(path.join(value.dest, "index.html"));
    try {
      await fs.symlink("/etc/hosts", path.join(value.dest, "index.html"));
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) return t.skip("symlinks unavailable");
      throw error;
    }
    await assert.rejects(verifyDirectory(value.dest, value.manifest), /Symlink rejected/);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("FIFO is rejected without blocking verification", async (t) => {
  const value = await setup();
  try {
    await importBundle({ ...value, expectedManifestHash: value.manifestHash, destination: value.dest });
    await fs.rm(path.join(value.dest, "index.html"));
    try {
      await execFileAsync("mkfifo", [path.join(value.dest, "index.html")]);
    } catch (error) {
      if (error.code === "ENOENT") return t.skip("mkfifo unavailable");
      throw error;
    }
    await assert.rejects(
      Promise.race([
        verifyDirectory(value.dest, value.manifest),
        new Promise((_, reject) => setTimeout(() => reject(new Error("verification blocked on FIFO")), 500)),
      ]),
      /Non-regular file/,
    );
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("oversized local input is rejected by manifest limits", () => {
  const value = documents([["index.html", Buffer.alloc(1)]]);
  const manifest = JSON.parse(value.manifestBytes);
  manifest.files[0].bytes = LIMITS.totalBytes + 1;
  const bytes = Buffer.from(JSON.stringify(manifest));
  assert.throws(() => parseManifest(bytes, sha256(bytes)), /exceed/);
});

test("oversized local input is rejected before reading", async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, "large.json");
  try {
    await fs.writeFile(file, Buffer.alloc(33));
    await assert.rejects(readInput(file, { maxBytes: 32 }), /size limit/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("existing non-matching destination is preserved", async () => {
  const value = await setup();
  try {
    await fs.mkdir(value.dest);
    await fs.writeFile(path.join(value.dest, "unrelated.txt"), "keep");
    await assert.rejects(
      importBundle({ ...value, expectedManifestHash: value.manifestHash, destination: value.dest }),
      /Missing file|Extra file/,
    );
    assert.equal(await fs.readFile(path.join(value.dest, "unrelated.txt"), "utf8"), "keep");
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

function fakeRequest(responses) {
  return (_url, _options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.end = () => queueMicrotask(() => {
      const next = responses.shift();
      const res = Readable.from(next.chunks ?? []);
      res.statusCode = next.status;
      res.headers = next.headers ?? {};
      res.resume = () => {};
      callback(res);
      if (next.abort) queueMicrotask(() => res.emit("aborted"));
    });
    req.destroy = (error) => req.emit("error", error);
    return req;
  };
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("interrupted download is rejected", async () => {
  await assert.rejects(downloadHttps("https://example.com/a", {
    lookupAddresses: publicLookup,
    request: fakeRequest([{ status: 200, chunks: [], abort: true }]),
  }), /interrupted/);
});

test("unsafe redirect is rejected", async () => {
  await assert.rejects(downloadHttps("https://example.com/a", {
    lookupAddresses: publicLookup,
    request: fakeRequest([{ status: 302, headers: { location: "http://example.com/b" } }]),
  }), /downgrade/);
});

test("malformed redirect is rejected without throwing outside the request", async () => {
  await assert.rejects(downloadHttps("https://example.com/a", {
    lookupAddresses: publicLookup,
    request: fakeRequest([{ status: 302, headers: { location: "https://[" } }]),
  }), /invalid/);
});

test("redirect target DNS is validated independently", async () => {
  const hosts = [];
  await assert.rejects(downloadHttps("https://example.com/a", {
    lookupAddresses: async (host) => {
      hosts.push(host);
      if (host === "private.example") throw new Error("private destination rejected");
      return publicLookup();
    },
    request: fakeRequest([{ status: 302, headers: { location: "https://private.example/b" } }]),
  }), /private destination/);
  assert.deepEqual(hosts, ["example.com", "private.example"]);
});

test("download has an end-to-end deadline", async () => {
  await assert.rejects(downloadHttps("https://example.com/a", {
    timeoutMs: 10,
    lookupAddresses: async () => new Promise(() => {}),
    request: fakeRequest([]),
  }), /timed out/);
});

test("static server rejects unsupported methods before success headers", async () => {
  const value = await setup();
  try {
    await importBundle({ ...value, expectedManifestHash: value.manifestHash, destination: value.dest });
    const handler = createStaticServer(value.dest, "index.html");
    const result = {};
    await handler({ method: "POST", url: "/" }, {
      writeHead(status, headers) { result.status = status; result.headers = headers; },
      end(body) { result.body = body; },
    });
    assert.equal(result.status, 405);
    assert.equal(result.body, "Method not allowed");
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("static server serves the chosen entrypoint at root", async () => {
  const value = await setup();
  let server;
  try {
    await importBundle({ ...value, expectedManifestHash: value.manifestHash, destination: value.dest });
    server = http.createServer(createStaticServer(value.dest, "index.html"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const response = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${address.port}/`, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode,
          type: res.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      }).on("error", reject);
    });
    assert.equal(response.status, 200);
    assert.equal(response.type, "text/html; charset=utf-8");
    assert.match(response.body, /Exact import test/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test("static server rejects symlinks escaping root", async (t) => {
  const value = await setup();
  try {
    await importBundle({ ...value, expectedManifestHash: value.manifestHash, destination: value.dest });
    try {
      await fs.symlink("/etc/hosts", path.join(value.dest, "outside"));
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) return t.skip("symlinks unavailable");
      throw error;
    }
    const handler = createStaticServer(value.dest, "index.html");
    const result = {};
    await handler({ method: "GET", url: "/outside" }, {
      writeHead(status) { result.status = status; },
      end(body) { result.body = body; },
    });
    assert.equal(result.status, 404);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});