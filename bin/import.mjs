#!/usr/bin/env node
import { formatError, importBundle, parseArgs, readInput } from "../lib/core.mjs";

try {
  const args = parseArgs(process.argv.slice(2), ["bundle", "manifest", "manifest-sha256", "dest"]);
  const [bundleBytes, manifestBytes] = await Promise.all([
    readInput(args.bundle),
    readInput(args.manifest),
  ]);
  const result = await importBundle({
    bundleBytes,
    manifestBytes,
    expectedManifestHash: args["manifest-sha256"],
    destination: args.dest,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(formatError(error));
  process.exitCode = error.code === "USAGE" ? 2 : 1;
}