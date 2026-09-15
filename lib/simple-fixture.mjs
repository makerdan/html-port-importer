import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ImportError,
  readInput,
  requireHash,
  sha256,
  validateRelativePath,
  verifyDirectory,
} from "./core.mjs";

export function projectPaths(scriptUrl) {
  const projectRoot = path.dirname(fileURLToPath(scriptUrl));
  return {
    projectRoot,
    fixtures: path.join(projectRoot, "fixtures"),
    manifest: path.join(projectRoot, "fixtures", "manifest.json"),
    destination: path.join(projectRoot, "imported-app"),
  };
}

function requireExactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new ImportError(`${label} has an invalid shape.`);
  }
}

export async function loadSimpleManifest(manifestPath) {
  const bytes = await readInput(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ImportError("Fixture manifest is not valid JSON.");
  }
  requireExactObject(manifest, ["version", "files"], "Fixture manifest");
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new ImportError("Fixture manifest version or file list is invalid.");
  }
  const seen = new Set();
  const folded = new Set();
  for (const file of manifest.files) {
    requireExactObject(file, ["path", "bytes", "sha256"], "Fixture manifest file");
    validateRelativePath(file.path);
    if (file.path.includes("/")) {
      throw new ImportError("Simple fixture paths must be filenames inside imported-app.");
    }
    if (seen.has(file.path) || folded.has(file.path.toLowerCase())) {
      throw new ImportError("Fixture manifest contains duplicate or case-colliding paths.");
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new ImportError("Fixture manifest byte length is invalid.");
    }
    requireHash(file.sha256, "Fixture file SHA-256");
    seen.add(file.path);
    folded.add(file.path.toLowerCase());
  }
  return manifest;
}

export async function loadVerifiedFixtureFiles(fixturesRoot, manifest) {
  const files = [];
  for (const item of manifest.files) {
    const source = path.join(fixturesRoot, ...item.path.split("/"));
    const relative = path.relative(fixturesRoot, source);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new ImportError("Fixture path escapes the fixtures directory.");
    }
    const bytes = await readInput(source);
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256.toLowerCase()) {
      throw new ImportError(`Fixture hash mismatch: ${item.path}`, "HASH_MISMATCH");
    }
    files.push({ path: item.path, bytes });
  }
  return files;
}

export function verificationManifest(manifest) {
  return {
    version: 1,
    bundleSha256: "0".repeat(64),
    entrypoint: manifest.files.some((file) => file.path === "index.html")
      ? "index.html"
      : manifest.files[0].path,
    files: manifest.files,
  };
}

export async function importSimpleFixture(destination, manifest, files) {
  const existing = await fs.lstat(destination).catch((error) =>
    error.code === "ENOENT" ? null : Promise.reject(error));
  const exactManifest = verificationManifest(manifest);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new ImportError("Existing imported-app is unsafe.");
    }
    const result = await verifyDirectory(destination, exactManifest);
    return { ...result, unchanged: true };
  }

  let created = false;
  try {
    await fs.mkdir(destination, { mode: 0o700 });
    created = true;
    for (const file of files) {
      await fs.writeFile(path.join(destination, file.path), file.bytes, {
        flag: "wx",
        mode: 0o644,
      });
    }
    const result = await verifyDirectory(destination, exactManifest);
    return { ...result, unchanged: false };
  } catch (error) {
    if (created) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}