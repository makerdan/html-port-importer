#!/usr/bin/env node
import { formatError, loadManifest, parseArgs, verifyDirectory } from "../lib/core.mjs";

try {
  const args = parseArgs(process.argv.slice(2), ["manifest", "manifest-sha256", "dest"]);
  const manifest = await loadManifest(args.manifest, args["manifest-sha256"]);
  console.log(JSON.stringify(await verifyDirectory(args.dest, manifest)));
} catch (error) {
  console.error(formatError(error));
  process.exitCode = error.code === "USAGE" ? 2 : 1;
}