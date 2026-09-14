import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import fs, { promises as fsp } from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  fileCount: 2048,
  pathBytes: 512,
  totalBytes: 64 * 1024 * 1024,
  redirects: 5,
  timeoutMs: 15_000,
});

export class ImportError extends Error {
  constructor(message, code = "INVALID_INPUT") {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseArgs(argv, required) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || i + 1 >= argv.length) {
      throw new ImportError("Arguments must be provided as --name value pairs.", "USAGE");
    }
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) throw new ImportError(`Duplicate argument: --${name}`, "USAGE");
    result[name] = argv[i + 1];
  }
  for (const name of required) {
    if (!result[name]) throw new ImportError(`Missing required argument: --${name}`, "USAGE");
  }
  return result;
}

export function requireHash(value, label = "SHA-256") {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new ImportError(`${label} must be exactly 64 hexadecimal characters.`);
  }
  return value.toLowerCase();
}

function isUnsafeAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    return reservedAddresses.check(address, "ipv4");
  }
  if (family === 6) {
    const normalized = address.toLowerCase().split("%")[0];
    if (normalized.startsWith("::ffff:")) return isUnsafeAddress(normalized.slice(7));
    return reservedAddresses.check(normalized, "ipv6");
  }
  return family === 0;
}

const reservedAddresses = new net.BlockList();
for (const [address, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"], ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"], ["198.18.0.0", 15, "ipv4"], ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"], ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"], ["::1", 128, "ipv6"], ["::ffff:0:0", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"], ["100::", 64, "ipv6"], ["2001::", 23, "ipv6"],
  ["2001:db8::", 32, "ipv6"], ["2002::", 16, "ipv6"], ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"],
]) reservedAddresses.addSubnet(address, prefix, family);

async function publicAddresses(hostname, signal) {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (signal?.aborted) throw signal.reason;
  if (!records.length || records.some(({ address }) => isUnsafeAddress(address))) {
    throw new ImportError("URL resolves to a private, reserved, or invalid address.", "UNSAFE_URL");
  }
  return records;
}

export async function downloadHttps(source, options = {}) {
  const maxBytes = options.maxBytes ?? LIMITS.inputBytes;
  const timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
  const lookupAddresses = options.lookupAddresses ?? publicAddresses;
  const request = options.request ?? https.request;
  const controller = new AbortController();
  let rejectDeadline;
  const deadlinePromise = new Promise((_, reject) => { rejectDeadline = reject; });
  const deadline = setTimeout(() => {
    const error = new ImportError("Download timed out.", "DOWNLOAD_TIMEOUT");
    controller.abort(error);
    rejectDeadline(error);
  }, timeoutMs);

  async function fetchUrl(rawUrl, redirectsLeft) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ImportError("Invalid URL.", "UNSAFE_URL");
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new ImportError("URL must use HTTPS and must not contain credentials.", "UNSAFE_URL");
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    const addresses = await lookupAddresses(url.hostname, controller.signal);
    let lookupIndex = 0;
    const lookup = (_hostname, lookupOptions, callback) => {
      const available = addresses.filter((item) =>
        !lookupOptions?.family || item.family === lookupOptions.family);
      const selected = available[lookupIndex++ % available.length];
      if (!selected) return callback(new Error("No validated address for requested family."));
      if (lookupOptions?.all) callback(null, available);
      else callback(null, selected.address, selected.family);
    };

    return await new Promise((resolve, reject) => {
      const req = request(url, {
        lookup,
        servername: url.hostname,
        signal: controller.signal,
        headers: { "user-agent": "html-port-importer/1", accept: "application/json" },
      }, (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          if (!res.headers.location || redirectsLeft === 0) {
            reject(new ImportError("Unsafe or excessive redirect.", "UNSAFE_REDIRECT"));
            return;
          }
          let next;
          try {
            next = new URL(res.headers.location, url);
          } catch {
            reject(new ImportError("Redirect location is invalid.", "UNSAFE_REDIRECT"));
            return;
          }
          if (next.protocol !== "https:") {
            reject(new ImportError("HTTPS downgrade redirect rejected.", "UNSAFE_REDIRECT"));
            return;
          }
          fetchUrl(next.href, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new ImportError(`Download failed with HTTP status ${status}.`, "DOWNLOAD_FAILED"));
          return;
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          reject(new ImportError("Downloaded input exceeds the size limit.", "TOO_LARGE"));
          return;
        }
        const chunks = [];
        let length = 0;
        res.on("data", (chunk) => {
          length += chunk.length;
          if (length > maxBytes) {
            res.destroy(new ImportError("Downloaded input exceeds the size limit.", "TOO_LARGE"));
          } else {
            chunks.push(chunk);
          }
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
        res.on("aborted", () => reject(new ImportError("Download was interrupted.", "DOWNLOAD_INTERRUPTED")));
      });
      req.on("error", reject);
      req.end();
    });
  }
  try {
    return await Promise.race([fetchUrl(source, LIMITS.redirects), deadlinePromise]);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

export async function readInput(source, options = {}) {
  if (/^https?:/i.test(source)) return downloadHttps(source, options);
  const maxBytes = options.maxBytes ?? LIMITS.inputBytes;
  const handle = await fsp.open(source, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ImportError("Input must be a regular file.");
    if (stat.size > maxBytes) {
      throw new ImportError("Input exceeds the size limit.", "TOO_LARGE");
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      length += chunk.length;
      if (length > maxBytes) throw new ImportError("Input exceeds the size limit.", "TOO_LARGE");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ImportError(`${label} is not valid JSON.`);
  }
}

export function validateRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 ||
      Buffer.byteLength(value) > LIMITS.pathBytes ||
      value.includes("\\") || /[\0-\x1f\x7f]/.test(value) ||
      value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new ImportError("File path is invalid.");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ImportError("File path contains traversal or empty segments.");
  }
  if (path.posix.normalize(value) !== value) throw new ImportError("File path is not normalized.");
  return value;
}

function exactObject(value, requiredKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...requiredKeys].sort().join("\0")) {
    throw new ImportError(`${label} has an invalid shape.`);
  }
}

function strictBase64(value) {
  if (typeof value !== "string" || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ImportError("File bytes are not strict canonical base64.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new ImportError("File bytes are not canonical base64.");
  return decoded;
}

export function parseManifest(bytes, expectedHash) {
  if (sha256(bytes) !== requireHash(expectedHash, "Expected manifest SHA-256")) {
    throw new ImportError("Manifest SHA-256 does not match.", "HASH_MISMATCH");
  }
  const value = parseJson(bytes, "Manifest");
  exactObject(value, ["version", "bundleSha256", "entrypoint", "files"], "Manifest");
  if (value.version !== 1 || !Array.isArray(value.files) || value.files.length > LIMITS.fileCount) {
    throw new ImportError("Manifest version or file count is invalid.");
  }
  requireHash(value.bundleSha256, "Bundle SHA-256");
  validateRelativePath(value.entrypoint);
  const seen = new Set();
  const folded = new Set();
  let total = 0;
  for (const file of value.files) {
    exactObject(file, ["path", "bytes", "sha256"], "Manifest file");
    validateRelativePath(file.path);
    if (seen.has(file.path) || folded.has(file.path.toLowerCase())) {
      throw new ImportError("Manifest contains duplicate or case-colliding paths.");
    }
    seen.add(file.path);
    folded.add(file.path.toLowerCase());
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new ImportError("Manifest byte length is invalid.");
    total += file.bytes;
    if (total > LIMITS.totalBytes) throw new ImportError("Manifest total bytes exceed the limit.", "TOO_LARGE");
    requireHash(file.sha256, "File SHA-256");
  }
  if (!seen.has(value.entrypoint)) throw new ImportError("Manifest entrypoint is not listed.");
  return value;
}

export function parseBundle(bytes, manifest) {
  if (sha256(bytes) !== manifest.bundleSha256.toLowerCase()) {
    throw new ImportError("Bundle SHA-256 does not match the manifest.", "HASH_MISMATCH");
  }
  const value = parseJson(bytes, "Bundle");
  exactObject(value, ["version", "entrypoint", "files"], "Bundle");
  if (value.version !== 1 || value.entrypoint !== manifest.entrypoint ||
      !Array.isArray(value.files) || value.files.length !== manifest.files.length) {
    throw new ImportError("Bundle disagrees with the manifest.");
  }
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const seen = new Set();
  const folded = new Set();
  let total = 0;
  const files = [];
  for (const file of value.files) {
    exactObject(file, ["path", "base64"], "Bundle file");
    validateRelativePath(file.path);
    if (seen.has(file.path) || folded.has(file.path.toLowerCase())) {
      throw new ImportError("Bundle contains duplicate or case-colliding paths.");
    }
    seen.add(file.path);
    folded.add(file.path.toLowerCase());
    const bytesValue = strictBase64(file.base64);
    total += bytesValue.length;
    if (total > LIMITS.totalBytes) throw new ImportError("Bundle total bytes exceed the limit.", "TOO_LARGE");
    const item = expected.get(file.path);
    if (!item || item.bytes !== bytesValue.length || item.sha256.toLowerCase() !== sha256(bytesValue)) {
      throw new ImportError(`Bundle file metadata mismatch: ${file.path}`);
    }
    files.push({ path: file.path, bytes: bytesValue });
  }
  if (seen.size !== expected.size) throw new ImportError("Bundle file list disagrees with the manifest.");
  return files;
}

function descriptorPath(handleOrFd, name = "") {
  const fd = typeof handleOrFd === "number" ? handleOrFd : handleOrFd.fd;
  return name ? `/proc/self/fd/${fd}/${name}` : `/proc/self/fd/${fd}`;
}

async function openChild(parent, name) {
  return fsp.open(
    descriptorPath(parent, name),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
}

async function hashHandle(handle, expectedLimit) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > expectedLimit) throw new ImportError("File size is invalid.", "VERIFY_FAILED");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    bytes += chunk.length;
    if (bytes > expectedLimit) throw new ImportError("File grew beyond its expected size.", "VERIFY_FAILED");
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function inspectAndVerify(rootHandle, manifest) {
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const found = new Set();
  let count = 0;
  let directories = 1;
  let total = 0;
  async function walk(directoryHandle, relative, depth) {
    if (depth > LIMITS.pathBytes / 2) throw new ImportError("Directory depth exceeds verification limit.", "VERIFY_FAILED");
    const entries = await fsp.readdir(descriptorPath(directoryHandle), { withFileTypes: true });
    for (const entry of entries) {
      const child = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (Buffer.byteLength(child) > LIMITS.pathBytes) throw new ImportError("Path exceeds verification limit.", "VERIFY_FAILED");
      let handle;
      try {
        handle = await openChild(directoryHandle, entry.name);
      } catch (error) {
        if (error.code === "ELOOP") throw new ImportError(`Symlink rejected: ${child}`, "VERIFY_FAILED");
        throw error;
      }
      try {
        const stat = await handle.stat();
        if (stat.isDirectory()) {
          directories += 1;
          if (directories > LIMITS.fileCount + 1) {
            throw new ImportError("Destination has too many directories.", "VERIFY_FAILED");
          }
          await walk(handle, child, depth + 1);
        } else if (stat.isFile()) {
          count += 1;
          const item = expected.get(child);
          if (!item) throw new ImportError(`Extra file: ${child}`, "VERIFY_FAILED");
          const file = await hashHandle(handle, item.bytes);
          total += file.bytes;
          if (count > LIMITS.fileCount || total > LIMITS.totalBytes) {
            throw new ImportError("Destination exceeds verification limits.", "VERIFY_FAILED");
          }
          if (file.bytes !== item.bytes || file.sha256 !== item.sha256.toLowerCase()) {
            throw new ImportError(`Changed file: ${child}`, "VERIFY_FAILED");
          }
          found.add(child);
        } else {
          throw new ImportError(`Non-regular file rejected: ${child}`, "VERIFY_FAILED");
        }
      } finally {
        await handle.close();
      }
    }
  }
  await walk(rootHandle, "", 0);
  for (const item of manifest.files) {
    if (!found.has(item.path)) throw new ImportError(`Missing file: ${item.path}`, "VERIFY_FAILED");
  }
}

export async function verifyDirectory(root, manifest) {
  const rootStat = await fsp.lstat(root).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!rootStat) throw new ImportError("Destination does not exist.", "VERIFY_FAILED");
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ImportError("Destination must be a real directory.", "VERIFY_FAILED");
  }
  let rootHandle;
  try {
    rootHandle = await fsp.open(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ELOOP") throw new ImportError("Destination symlink rejected.", "VERIFY_FAILED");
    throw error;
  }
  try {
    await inspectAndVerify(rootHandle, manifest);
  } finally {
    await rootHandle.close();
  }
  return { status: "Verified", files: manifest.files.length, entrypoint: manifest.entrypoint };
}

async function ensureSafeParent(destination) {
  const absolute = path.resolve(destination);
  if (path.basename(absolute) === path.parse(absolute).root) throw new ImportError("Destination cannot be a filesystem root.");
  const parent = path.dirname(absolute);
  await fsp.mkdir(parent, { recursive: true });
  const parentReal = await fsp.realpath(parent);
  const safeDestination = path.join(parentReal, path.basename(absolute));
  return { absolute: safeDestination, parentReal };
}

export async function importBundle({ bundleBytes, manifestBytes, expectedManifestHash, destination }) {
  const manifest = parseManifest(manifestBytes, expectedManifestHash);
  const files = parseBundle(bundleBytes, manifest);
  const { absolute, parentReal } = await ensureSafeParent(destination);
  const existing = await fsp.lstat(absolute).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new ImportError("Existing destination is unsafe.");
    const result = await verifyDirectory(absolute, manifest);
    return { ...result, unchanged: true };
  }
  const stage = await fsp.mkdtemp(path.join(parentReal, ".html-port-import-"));
  let reservationIdentity = null;
  try {
    for (const file of files) {
      const target = path.join(stage, ...file.path.split("/"));
      const relative = path.relative(stage, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ImportError("Path escapes staging directory.");
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, file.bytes, { flag: "wx", mode: 0o644 });
    }
    await verifyDirectory(stage, manifest);
    try {
      await fsp.mkdir(absolute, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new ImportError("Destination appeared during import; nothing was replaced.");
      }
      throw error;
    }
    reservationIdentity = await fsp.lstat(absolute);
    await fsp.rename(stage, absolute);
    reservationIdentity = null;
    return { ...(await verifyDirectory(absolute, manifest)), unchanged: false };
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (reservationIdentity) {
      const current = await fsp.lstat(absolute).catch((problem) =>
        problem.code === "ENOENT" ? null : Promise.reject(problem));
      if (current && current.dev === reservationIdentity.dev && current.ino === reservationIdentity.ino &&
          current.isDirectory()) {
        await fsp.rmdir(absolute).catch(() => {});
      }
    }
    throw error;
  }
}

export function formatError(error) {
  return `${error.code ?? "ERROR"}: ${error.message}`;
}

export async function loadManifest(source, expectedHash, options) {
  const bytes = await readInput(source, options);
  return parseManifest(bytes, expectedHash);
}

export function createStaticServer(root, entrypoint) {
  const rootFd = fs.openSync(
    root,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  validateRelativePath(entrypoint);
  const types = new Map([
    [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"],
  ]);
  return async function handler(req, res) {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
        return res.end("Method not allowed");
      }
      const url = new URL(req.url, "http://localhost");
      let relative = url.pathname === "/" ? entrypoint : decodeURIComponent(url.pathname.slice(1));
      validateRelativePath(relative);
      const parts = relative.split("/");
      let parent = rootFd;
      const openedParents = [];
      let handle;
      try {
        for (const part of parts.slice(0, -1)) {
          const directory = await openChild(parent, part);
          const stat = await directory.stat();
          if (!stat.isDirectory()) {
            await directory.close();
            throw new ImportError("Not found.");
          }
          openedParents.push(directory);
          parent = directory;
        }
        handle = await openChild(parent, parts.at(-1));
      } finally {
        await Promise.all(openedParents.map((item) => item.close()));
      }
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        throw new ImportError("Not found.");
      }
      res.writeHead(200, {
        "content-type": types.get(path.extname(relative).toLowerCase()) ?? "application/octet-stream",
        "content-length": stat.size,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      if (req.method === "HEAD") {
        await handle.close();
        return res.end();
      }
      handle.createReadStream()
        .on("error", () => res.destroy())
        .pipe(res);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  };
}

export async function temporaryDirectory(prefix = "html-port-") {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}