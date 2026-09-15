#!/usr/bin/env node
import { formatError, verifyDirectory } from "./lib/core.mjs";
import {
  loadSimpleManifest,
  projectPaths,
  verificationManifest,
} from "./lib/simple-fixture.mjs";

try {
  if (process.argv.length !== 2) {
    throw Object.assign(new Error("This command does not accept arguments."), { code: "USAGE" });
  }
  const paths = projectPaths(import.meta.url);
  const manifest = await loadSimpleManifest(paths.manifest);
  const result = await verifyDirectory(paths.destination, verificationManifest(manifest));
  console.log(`PASS: verified ${result.files} files in imported-app.`);
} catch (error) {
  console.error(`FAIL: ${formatError(error)}`);
  process.exitCode = error.code === "USAGE" ? 2 : 1;
}