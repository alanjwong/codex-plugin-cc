#!/usr/bin/env node
// Regenerates MODIFICATIONS.md — the Apache-2.0 §4(b) notice inventory of
// every upstream file this fork modified and every file it added — from the
// git diff against the recorded upstream base. Run after any change and
// commit the result.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runCommandChecked } from "../plugins/codex/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_BASE = "db52e28f4d9ded852ab3942cea316258ae4ef346"; // upstream v1.0.6
// Default: diff the working tree so uncommitted changes are inventoried too.
const target = process.argv[2] ?? null;

const diff = runCommandChecked(
  "git",
  ["diff", "--no-renames", "--name-status", UPSTREAM_BASE, ...(target ? [target] : [])],
  { cwd: ROOT }
);
const modified = [];
const added = [];
const removed = [];
for (const line of diff.stdout.split("\n")) {
  const [status, ...rest] = line.trim().split(/\t/);
  const file = rest.join("\t");
  if (!status || !file || file === "MODIFICATIONS.md") {
    continue;
  }
  if (status.startsWith("M")) modified.push(file);
  else if (status.startsWith("A")) added.push(file);
  else if (status.startsWith("D")) removed.push(file);
  else throw new Error(`Unexpected git diff status "${status}" for ${file}`);
}

const lines = [
  "# Modifications",
  "",
  "This repository is an unofficial fork of",
  "[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc),",
  `based on upstream v1.0.6 (commit \`${UPSTREAM_BASE.slice(0, 7)}\`).`,
  "It is not affiliated with or endorsed by OpenAI.",
  "",
  "Per Apache License 2.0 section 4(b), this file records that the fork",
  "changed the upstream files listed below. See the README section",
  '"The Reliability Overhaul" and `plugins/codex/CHANGELOG.md` for what',
  "changed and why. `LICENSE` and `NOTICE` are unmodified upstream copies.",
  "",
  `## Upstream files modified by this fork (${modified.length})`,
  "",
  ...modified.sort().map((file) => `- \`${file}\``),
  "",
  `## Files added by this fork (${added.length + 1})`,
  "",
  "- `MODIFICATIONS.md` (this file)",
  ...added.sort().map((file) => `- \`${file}\``),
  ""
];
if (removed.length > 0) {
  lines.push(`## Upstream files removed by this fork (${removed.length})`, "", ...removed.sort().map((file) => `- \`${file}\``), "");
}
lines.push("Regenerate with `node scripts/generate-modifications.mjs`.", "");

fs.writeFileSync(path.join(ROOT, "MODIFICATIONS.md"), lines.join("\n"), "utf8");
process.stdout.write(`MODIFICATIONS.md: ${modified.length} modified, ${added.length + 1} added, ${removed.length} removed.\n`);
