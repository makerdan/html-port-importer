import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Router, type IRouter } from "express";

const router: IRouter = Router();
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_JSON_FIELD_BYTES = 12 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 45_000;
const MAX_CONCURRENT_IMPORTERS = 2;
let activeImporters = 0;
const IMPORT_ROOT = path.resolve(
  process.env.HTML_PORT_IMPORT_ROOT ?? path.join(os.tmpdir(), "html-port-imports"),
);

type ImporterRequest = {
  bundleBase64?: unknown;
  manifestBase64?: unknown;
  manifestSha256?: unknown;
  destination?: unknown;
};

function decodeTransport(value: unknown, label: string, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_JSON_FIELD_BYTES ||
      value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not valid base64.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > maxBytes || decoded.toString("base64") !== value) {
    throw new Error(`${label} exceeds the size limit or is not canonical base64.`);
  }
  return decoded;
}

function validateHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("Manifest SHA-256 must be exactly 64 hexadecimal characters.");
  }
  return value.toLowerCase();
}

async function validateDestination(value: unknown): Promise<string> {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ||
      value === "." || value === "..") {
    throw new Error("Destination must be a single safe folder name.");
  }
  await fs.mkdir(IMPORT_ROOT, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(IMPORT_ROOT);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      await fs.realpath(IMPORT_ROOT) !== IMPORT_ROOT) {
    throw new Error("The dedicated import area is unsafe.");
  }
  return path.join(IMPORT_ROOT, value);
}

async function runImporter(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  if (activeImporters >= MAX_CONCURRENT_IMPORTERS) {
    throw new Error("Importer capacity is currently full. Try again shortly.");
  }
  const roots = [
    process.cwd(),
    path.resolve(process.cwd(), "..", ".."),
  ];
  const projectRoot = roots.find((root) =>
    existsSync(path.join(root, "bin", "import.mjs")) &&
    existsSync(path.join(root, "lib", "core.mjs")));
  if (!projectRoot) throw new Error("Importer CLI is unavailable.");
  activeImporters += 1;
  const entrypoint = path.join(projectRoot, "bin", args[0]);
  let child;
  try {
    child = spawn(process.execPath, [entrypoint, ...args.slice(1)], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    activeImporters -= 1;
    throw error;
  }
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      complete: typeof resolve | typeof reject,
      value: { status: number; stdout: string; stderr: string } | Error,
    ) => {
      if (settled) return;
      settled = true;
      activeImporters -= 1;
      complete(value as never);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error("Importer timed out."));
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      finish(reject, error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      finish(resolve, { status: status ?? 1, stdout, stderr });
    });
  });
}

function responseFromRun(run: { status: number; stdout: string; stderr: string }) {
  if (run.status === 0) {
    try {
      const parsed = JSON.parse(run.stdout);
      return { status: "Verified", result: parsed };
    } catch {
      return { status: "Failed", message: "Importer returned an invalid result." };
    }
  }
  const lines = run.stderr.trim().split(/\r?\n/).filter(Boolean);
  const detail = lines.length === 1 && /^[A-Z_]+: /.test(lines[0])
    ? lines[0]
    : "Importer process failed.";
  const blocked = /UNSAFE_URL|DOWNLOAD_TIMEOUT|DOWNLOAD_INTERRUPTED|unsupported|timed out/i.test(detail);
  return { status: blocked ? "Blocked" : "Failed", message: detail.replace(/[\r\n]+/g, " ").slice(0, 500) };
}

async function withTempFiles<T>(
  bundle: Buffer | null,
  manifest: Buffer,
  action: (bundlePath: string | null, manifestPath: string) => Promise<T>,
): Promise<T> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "html-port-gui-"));
  const manifestPath = path.join(temp, `manifest-${randomUUID()}.json`);
  const bundlePath = bundle ? path.join(temp, `bundle-${randomUUID()}.json`) : null;
  try {
    await fs.writeFile(manifestPath, manifest, { flag: "wx", mode: 0o600 });
    if (bundle && bundlePath) await fs.writeFile(bundlePath, bundle, { flag: "wx", mode: 0o600 });
    return await action(bundlePath, manifestPath);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

router.post("/importer/import", async (req, res): Promise<void> => {
  try {
    const body = req.body as ImporterRequest;
    const bundle = decodeTransport(body.bundleBase64, "Bundle", MAX_INPUT_BYTES);
    const manifest = decodeTransport(body.manifestBase64, "Manifest", MAX_MANIFEST_BYTES);
    const hash = validateHash(body.manifestSha256);
    const destination = await validateDestination(body.destination);
    const result = await withTempFiles(bundle, manifest, async (bundlePath, manifestPath) => {
      const run = await runImporter(["import.mjs", "--bundle", bundlePath!, "--manifest", manifestPath, "--manifest-sha256", hash, "--dest", destination]);
      return responseFromRun(run);
    });
    res.status(result.status === "Verified" ? 200 : 422).json(result);
  } catch (error) {
    res.status(400).json({ status: "Failed", message: error instanceof Error ? error.message : "Invalid request." });
  }
});

router.post("/importer/verify", async (req, res): Promise<void> => {
  try {
    const body = req.body as ImporterRequest;
    const manifest = decodeTransport(body.manifestBase64, "Manifest", MAX_MANIFEST_BYTES);
    const hash = validateHash(body.manifestSha256);
    const destination = await validateDestination(body.destination);
    const result = await withTempFiles(null, manifest, async (_bundlePath, manifestPath) => {
      const run = await runImporter(["verify.mjs", "--manifest", manifestPath, "--manifest-sha256", hash, "--dest", destination]);
      return responseFromRun(run);
    });
    res.status(result.status === "Verified" ? 200 : 422).json(result);
  } catch (error) {
    res.status(400).json({ status: "Failed", message: error instanceof Error ? error.message : "Invalid request." });
  }
});

export default router;