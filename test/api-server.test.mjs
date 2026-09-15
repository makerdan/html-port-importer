import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not reserve a test port.");
  return port;
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`API test server exited with status ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/healthz`);
      if (response.ok) return;
    } catch {
      // The process may still be binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("API test server did not become healthy.");
}

test("API blocks cross-origin imports, normalizes JSON errors, and limits request bursts", async () => {
  await execFileAsync("pnpm", ["--filter", "@workspace/api-server", "run", "build"], {
    cwd: repositoryRoot,
  });
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["artifacts/api-server/dist/index.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await waitForHealth(baseUrl, child);

    const crossOrigin = await fetch(`${baseUrl}/api/importer/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://untrusted.example",
      },
      body: "{}",
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await crossOrigin.json(), {
      status: "Blocked",
      message: "Cross-origin importer requests are not allowed.",
    });

    const malformed = await fetch(`${baseUrl}/api/importer/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers.get("content-type") ?? "", /^application\/json/);
    const malformedBody = await malformed.text();
    assert.doesNotMatch(malformedBody, /SyntaxError|node_modules|workspace/);
    assert.deepEqual(JSON.parse(malformedBody), {
      status: "Failed",
      message: "Request body is not valid JSON.",
    });

    for (let count = 0; count < 19; count += 1) {
      const response = await fetch(`${baseUrl}/api/importer/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 400);
    }
    const limited = await fetch(`${baseUrl}/api/importer/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      status: "Blocked",
      message: "Too many importer requests. Try again shortly.",
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("close", resolve);
    });
  }

  assert.equal(stderr, "");
});