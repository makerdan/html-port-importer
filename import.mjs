#!/usr/bin/env node
import { formatError } from "./lib/core.mjs";
import {
  importSimpleFixture,
  loadSimpleManifest,
  loadVerifiedFixtureFiles,
  projectPaths,
} from "./lib/simple-fixture.mjs";

try {
  if (process.argv.length !== 2) {
    throw Object.assign(new Error("This command does not accept arguments."), { code: "USAGE" });
  }
  const paths = projectPaths(import.meta.url);
  const manifest = await loadSimpleManifest(paths.manifest);
  const files = await loadVerifiedFixtureFiles(paths.fixtures, manifest);
  const result = await importSimpleFixture(paths.destination, manifest, files);
  console.log(result.unchanged
    ? `PASS: imported-app already matches ${result.files} files.`
    : `PASS: imported and verified ${result.files} files in imported-app.`);
} catch (error) {
  console.error(`FAIL: ${formatError(error)}`);
  process.exitCode = error.code === "USAGE" ? 2 : 1;
}