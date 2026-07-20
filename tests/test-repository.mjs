import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

export function createTestRepository(files = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-test-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "marketplace-test@example.invalid"]);
  git(repo, ["config", "user.name", "Marketplace Test"]);
  writeFiles(repo, files);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  return repo;
}

export function writeFiles(repo, files) {
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(repo, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
}

export function removeTestRepository(repo) {
  fs.rmSync(repo, { recursive: true, force: true });
}
