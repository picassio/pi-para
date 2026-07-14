#!/usr/bin/env node
/* v8 ignore start */
// Cross-platform post-tsc asset copy (replaces POSIX mkdir -p/cp in npm build).
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 1. Web UI client bundle
const webuiSrc = join(root, "src", "webui", "client", "dist", "index.html");
const webuiDestDir = join(root, "dist", "webui", "client", "dist");
await mkdir(webuiDestDir, { recursive: true });
if (existsSync(webuiSrc)) {
  await cp(webuiSrc, join(webuiDestDir, "index.html"));
}
