#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(label, command, args) {
  console.log(`\n[${label}]`);
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) process.exitCode = 1;
}

run("Marketplace structure", process.execPath, ["scripts/validate-marketplace.mjs"]);

const tests = path.join(ROOT, "tests");
const testFiles = fs.existsSync(tests)
  ? fs.readdirSync(tests).filter((file) => file.endsWith(".test.mjs")).map((file) => path.join("tests", file))
  : [];
if (testFiles.length > 0) {
  run("Automated tests", process.execPath, ["--test", ...testFiles]);
}

if (!process.exitCode) console.log("\nAll local validations passed");
