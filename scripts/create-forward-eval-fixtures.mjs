#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function write(repo, file, content) {
  const absolute = path.join(repo, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function initialize(root, name, files) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "forward-eval@example.invalid"]);
  git(repo, ["config", "user.name", "Forward Eval"]);
  Object.entries(files).forEach(([file, content]) => write(repo, file, content));
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  return repo;
}

const config = JSON.stringify({
  schemaVersion: "1.0",
  impact: {
    pairedApplications: [{
      name: "regional-web-surfaces",
      scopes: ["apps/mobile-web", "apps/regional-web"],
    }],
  },
}, null, 2);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-forward-evals-"));
const common = {
  "AGENTS.md": [
    "# Rules",
    "",
    "- Financial calculations, comparisons, and formatting must use DecimalMath from @acme/shared-utils.",
    "- When peer web applications contain the same relative file, confirm whether both need the change.",
    "- Reviews are read-only and must not modify files.",
    "",
  ].join("\n"),
  ".ai-marketplace.json": config,
  "package.json": "{\"private\":true}\n",
  "apps/mobile-web/package.json": "{\"name\":\"@acme/mobile-web\",\"dependencies\":{\"@acme/shared-utils\":\"workspace:*\"}}\n",
  "apps/regional-web/package.json": "{\"name\":\"@acme/regional-web\",\"dependencies\":{\"@acme/shared-utils\":\"workspace:*\"}}\n",
  "packages/shared-utils/package.json": "{\"name\":\"@acme/shared-utils\"}\n",
};

const risk = initialize(root, "risk", {
  ...common,
  "apps/mobile-web/app/order/page.tsx": [
    'import { DecimalMath } from "@acme/shared-utils";',
    "export function calculateOrderTotal(price: number, quantity: number) {",
    "  return DecimalMath.times(price, quantity);",
    "}",
    "",
  ].join("\n"),
  "apps/regional-web/app/order/page.tsx": [
    'import { DecimalMath } from "@acme/shared-utils";',
    "export function calculateOrderTotal(price: number, quantity: number) {",
    "  return DecimalMath.times(price, quantity);",
    "}",
    "",
  ].join("\n"),
});
write(risk, "apps/mobile-web/app/order/page.tsx", [
  "export function calculateOrderTotal(price: number, quantity: number) {",
  "  return price * quantity;",
  "}",
  "",
].join("\n"));

const style = initialize(root, "style", {
  ...common,
  "apps/admin-dashboard/src/components/Status.tsx": [
    "export function Status() {",
    "  return <span>Ready</span>;",
    "}",
    "",
  ].join("\n"),
});
write(style, "apps/admin-dashboard/src/components/Status.tsx", [
  "export function Status() {",
  "    return <span>Ready</span>;",
  "}",
  "",
].join("\n"));

console.log(JSON.stringify({ root, risk, style }));
