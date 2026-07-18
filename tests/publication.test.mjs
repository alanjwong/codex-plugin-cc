import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function inventoryEntries(source, title) {
  const pattern = new RegExp(
    `^## ${title} \\((\\d+)\\)\\n\\n([\\s\\S]*?)(?=\\n## |\\nRegenerate with )`,
    "m"
  );
  const match = source.match(pattern);
  assert.ok(match, `missing MODIFICATIONS.md section: ${title}`);

  const expectedCount = Number(match[1]);
  const entries = [...match[2].matchAll(/^- `([^`]+)`(?: .*)?$/gm)].map((entry) => entry[1]);
  assert.equal(entries.length, expectedCount, `${title} header count must match its entries`);
  return entries;
}

test("marketplace and plugin metadata pin the publication identity", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const plugin = readJson("plugins/codex/.claude-plugin/plugin.json");

  assert.equal(marketplace.name, "alanjwong-codex");
  assert.equal(marketplace.owner.name, "alanjwong");
  assert.equal(marketplace.plugins[0].name, "codex");
  assert.equal(marketplace.plugins[0].source, "./plugins/codex");
  assert.equal(plugin.name, "codex");
  assert.ok(plugin.author.name.includes("alanjwong"));
});

test("README pins install commands and omits stale publication links", () => {
  const readme = read("README.md");

  assert.match(readme, /alanjwong\/codex-plugin-cc/);
  assert.match(readme, /codex@alanjwong-codex/);
  assert.doesNotMatch(readme, /plugin-demo\.webm/i);
  assert.doesNotMatch(readme, /#what-does-the-review-gate-do/i);
});

test("pull request CI pins Codex and uses a read-only unprivileged trigger", () => {
  const workflow = read(".github/workflows/pull-request-ci.yml");

  assert.match(workflow, /@openai\/codex@0\.144\.4/);
  assert.match(workflow, /^\s*pull_request:\s*$/m);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /^\s*contents:\s*read\s*$/m);
  assert.doesNotMatch(workflow, /secrets\./);
});

test("removed plugin demo asset is absent", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "docs", "plugin-demo.webm")), false);
});

test("MODIFICATIONS.md section counts and required modified files stay consistent", () => {
  const modifications = read("MODIFICATIONS.md");
  const modified = inventoryEntries(modifications, "Upstream files modified by this fork");
  inventoryEntries(modifications, "Files added by this fork");

  assert.ok(modified.includes("plugins/codex/scripts/lib/state.mjs"));
  assert.ok(modified.includes("README.md"));
});
