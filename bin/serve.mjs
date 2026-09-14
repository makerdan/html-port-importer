#!/usr/bin/env node
import http from "node:http";
import { createStaticServer, formatError, parseArgs } from "../lib/core.mjs";

try {
  const args = parseArgs(process.argv.slice(2), ["root", "entrypoint", "port"]);
  const port = Number(args.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be an integer from 1 to 65535.");
  const server = http.createServer(createStaticServer(args.root, args.entrypoint));
  server.listen(port, "127.0.0.1", () => console.log(`Serving on http://127.0.0.1:${port}/`));
} catch (error) {
  console.error(formatError(error));
  process.exitCode = 2;
}