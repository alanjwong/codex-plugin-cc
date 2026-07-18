#!/usr/bin/env node
// Cross-platform prebuild (replaces the POSIX-only `mkdir -p` shell script):
// regenerates the app-server TypeScript types from the local codex CLI.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runCommand } from "../plugins/codex/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "plugins", "codex", ".generated", "app-server-types");

fs.mkdirSync(OUT_DIR, { recursive: true });
const result = runCommand("codex", ["app-server", "generate-ts", "--out", OUT_DIR], { cwd: ROOT });
if (result.error || result.status !== 0) {
  const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`;
  process.stderr.write(`prebuild: codex app-server generate-ts failed: ${detail}\n`);
  process.exit(1);
}
