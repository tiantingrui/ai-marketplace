# Git 安全与数据最小化实施计划

> **供代理执行：** 必须使用子技能 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐项实施。子代理只修改本计划授权文件，不创建提交。

**目标：** 将原始 revision 一次解析为固定 commit OID，确保敏感路径在内容级 Git 命令前被过滤，并禁止 external diff、textconv 和错误 stdout 泄漏。

**架构：** `createComparisonContext()` 为一次顶层报告创建携带不可枚举内部快照的冻结 options context；`resolveComparison()` 只在该 context 内复用 OID，原始 options 对象跨两次报告复用时会重新解析。全部内容收集先取得安全 changed-file 状态，再以 literal pathspec 分批执行 diff；三个报告入口的 context 接线由总控计划在并行 barrier 后统一完成。

**技术栈：** Node.js 20+ ESM、Node `node:test`、Git CLI；仅使用 Node 内建模块。

**设计规格：** `docs/superpowers/specs/2026-07-21-marketplace-p0-foundation-design.md`

---

## 唯一写入范围

**文件：**

- 修改：`plugins/frontend-engineering-standard/scripts/lib/git-evidence.mjs`
- 新建：`tests/git-evidence.test.mjs`

前置依赖 `tests/test-repository.mjs` 由总控计划冻结；本工作流不得修改 CLI、rule、impact、review-context 或共享测试 helper。

## 冻结导出契约

```js
createComparisonContext(repository, options = {})
// => frozen options context；公开字段保持不变，内部绑定一次 comparison snapshot

resolveComparison(repository, options = {})
// => Object.freeze({
//   baseLabel,
//   headLabel,
//   baseOid,
//   headOid,
//   includeWorkingTree,
//   displayRange,
// })

probeGitRevParseEndOfOptions()
// => Object.freeze({ supported, message })
```

### 任务 1：写 revision 快照与 OID-only diff 红测试

**文件：**

- 新建：`tests/git-evidence.test.mjs`

- [ ] **步骤 1：创建测试基础设施**

创建文件并写入：

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  collectChangedFiles,
  collectChangedLines,
  collectNonWhitespaceDiff,
  collectSafeDiff,
  createComparisonContext,
  describeRange,
  isSensitivePath,
  probeGitRevParseEndOfOptions,
  resolveComparison,
} from "../plugins/frontend-engineering-standard/scripts/lib/git-evidence.mjs";
import {
  createTestRepository,
  removeTestRepository,
  writeFiles,
} from "./test-repository.mjs";

function findGit() {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory || ".", "git");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error("Git executable was not found");
}

const REAL_GIT = findGit();

function git(repo, args, { input } = {}) {
  const result = spawnSync(REAL_GIT, args, { cwd: repo, encoding: "utf8", input });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || result.error?.message);
  return result.stdout.trim();
}

function commitAll(repo, message) {
  git(repo, ["add", "--", "."]);
  git(repo, ["commit", "-qm", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function installGitTrace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "git-evidence-trace-"));
  const executable = path.join(directory, "git");
  const log = path.join(directory, "calls.jsonl");
  const previous = {
    PATH: process.env.PATH,
    realGit: process.env.AI_MARKETPLACE_REAL_GIT,
    log: process.env.AI_MARKETPLACE_GIT_LOG,
    failContent: process.env.AI_MARKETPLACE_FAIL_CONTENT,
    leak: process.env.AI_MARKETPLACE_LEAK_TEXT,
    unsupported: process.env.AI_MARKETPLACE_UNSUPPORTED_END_OF_OPTIONS,
  };

  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AI_MARKETPLACE_GIT_LOG, JSON.stringify(args) + "\\n");
if (process.env.AI_MARKETPLACE_FAIL_CONTENT === "1" && args[0] === "diff" && !args.includes("--name-status")) {
  process.stdout.write(process.env.AI_MARKETPLACE_LEAK_TEXT || "");
  process.exit(42);
}
if (
  process.env.AI_MARKETPLACE_UNSUPPORTED_END_OF_OPTIONS === "1"
  && args[0] === "rev-parse"
  && args.includes("--end-of-options")
) {
  process.stderr.write("unknown option: --end-of-options");
  process.exit(129);
}
const result = spawnSync(process.env.AI_MARKETPLACE_REAL_GIT, args, { stdio: "inherit" });
if (result.error) {
  process.stderr.write(result.error.message);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
`, { mode: 0o755 });

  process.env.PATH = `${directory}${path.delimiter}${previous.PATH ?? ""}`;
  process.env.AI_MARKETPLACE_REAL_GIT = REAL_GIT;
  process.env.AI_MARKETPLACE_GIT_LOG = log;
  delete process.env.AI_MARKETPLACE_FAIL_CONTENT;
  delete process.env.AI_MARKETPLACE_LEAK_TEXT;
  delete process.env.AI_MARKETPLACE_UNSUPPORTED_END_OF_OPTIONS;

  t.after(() => {
    process.env.PATH = previous.PATH;
    for (const [key, value] of [
      ["AI_MARKETPLACE_REAL_GIT", previous.realGit],
      ["AI_MARKETPLACE_GIT_LOG", previous.log],
      ["AI_MARKETPLACE_FAIL_CONTENT", previous.failContent],
      ["AI_MARKETPLACE_LEAK_TEXT", previous.leak],
      ["AI_MARKETPLACE_UNSUPPORTED_END_OF_OPTIONS", previous.unsupported],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  return {
    calls() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    clear() {
      fs.writeFileSync(log, "");
    },
  };
}
```

- [ ] **步骤 2：增加快照、可移动引用和 option-shaped 引用测试**

追加：

```js
test("comparison snapshots freeze labels and commit OIDs", (t) => {
  const repo = createTestRepository({ "src/value.ts": "export const value = 1;\n" });
  t.after(() => removeTestRepository(repo));
  const baseOid = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["branch", "base-branch", baseOid]);
  git(repo, ["tag", "light-base", baseOid]);
  git(repo, ["tag", "-a", "annotated-base", "-m", "annotated", baseOid]);
  writeFiles(repo, { "src/value.ts": "export const value = 2;\n" });
  const headOid = commitAll(repo, "second");

  for (const reference of ["base-branch", "light-base", "annotated-base", baseOid]) {
    const options = { base: reference };
    const context = createComparisonContext(repo, options);
    const snapshot = resolveComparison(repo, context);
    assert.deepEqual(snapshot, {
      baseLabel: reference,
      headLabel: "working-tree",
      baseOid,
      headOid: null,
      includeWorkingTree: true,
      displayRange: `${reference}..working-tree`,
    });
    assert.ok(Object.isFrozen(snapshot));
    assert.strictEqual(resolveComparison(repo, context), snapshot);
  }

  const explicit = resolveComparison(repo, { base: "light-base", head: "HEAD" });
  assert.equal(explicit.baseOid, baseOid);
  assert.equal(explicit.headOid, headOid);
  assert.equal(explicit.displayRange, "light-base..HEAD");
});

test("a movable reference is frozen within one context but refreshed for the next report", (t) => {
  const repo = createTestRepository({ "src/base.ts": "export const base = true;\n" });
  t.after(() => removeTestRepository(repo));
  const baseOid = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["branch", "moving-base", baseOid]);
  writeFiles(repo, { "src/head.ts": "export const head = true;\n" });
  const headOid = commitAll(repo, "head");
  const options = { base: "moving-base" };
  const firstContext = createComparisonContext(repo, options);
  const first = resolveComparison(repo, firstContext);
  git(repo, ["update-ref", "refs/heads/moving-base", headOid]);
  assert.strictEqual(resolveComparison(repo, firstContext), first);
  assert.equal(first.baseOid, baseOid);

  const secondContext = createComparisonContext(repo, options);
  const second = resolveComparison(repo, secondContext);
  assert.notStrictEqual(second, first);
  assert.equal(second.baseOid, headOid);
});

test("option-shaped references only enter diff as resolved OIDs", (t) => {
  const repo = createTestRepository({ "src/value.ts": "export const value = 1;\n" });
  t.after(() => removeTestRepository(repo));
  const baseOid = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/heads/--option-base", baseOid]);
  writeFiles(repo, { "src/value.ts": "export const value = 2;\n" });
  const headOid = commitAll(repo, "option head");
  git(repo, ["update-ref", "refs/heads/--option-head", headOid]);
  const trace = installGitTrace(t);
  const options = createComparisonContext(repo, { base: "--option-base", head: "--option-head" });
  const snapshot = resolveComparison(repo, options);

  collectChangedFiles(repo, options);
  collectChangedLines(repo, options);
  collectSafeDiff(repo, options);
  collectNonWhitespaceDiff(repo, options);

  const diffCalls = trace.calls().filter((args) => args[0] === "diff");
  assert.ok(diffCalls.length > 0);
  for (const args of diffCalls) {
    assert.ok(args.includes(snapshot.baseOid));
    assert.ok(args.includes(snapshot.headOid));
    assert.ok(!args.includes("--option-base"));
    assert.ok(!args.includes("--option-head"));
  }
  assert.equal(describeRange(options), "--option-base..--option-head");
});
```

- [ ] **步骤 3：增加无效 revision 必须在 diff 前失败的测试**

```js
test("invalid revisions fail before any diff command", (t) => {
  const repo = createTestRepository({ "src/value.ts": "export const value = 1;\n" });
  t.after(() => removeTestRepository(repo));
  const blobOid = git(repo, ["hash-object", "-w", "--stdin"], { input: "blob\n" });
  const treeOid = git(repo, ["rev-parse", "HEAD^{tree}"]);
  const trace = installGitTrace(t);
  const cases = [
    [{ head: "HEAD" }, /--head requires --base/],
    [{ base: "" }, /Invalid base revision/],
    [{ base: "--missing-option-shaped-ref" }, /Invalid base revision/],
    [{ base: blobOid }, /Invalid base revision/],
    [{ base: treeOid }, /Invalid base revision/],
    [{ base: "HEAD", head: "" }, /Invalid head revision/],
    [{ base: "HEAD", head: "--missing-option-shaped-ref" }, /Invalid head revision/],
  ];
  for (const [options, pattern] of cases) {
    trace.clear();
    assert.throws(() => collectChangedFiles(repo, options), pattern);
    assert.equal(trace.calls().filter((args) => args[0] === "diff").length, 0);
  }
});

test("unsupported rev-parse capability fails before repository diff", (t) => {
  const repo = createTestRepository({ "src/value.ts": "export const value = 1;\n" });
  t.after(() => removeTestRepository(repo));
  const trace = installGitTrace(t);
  process.env.AI_MARKETPLACE_UNSUPPORTED_END_OF_OPTIONS = "1";

  assert.throws(
    () => collectChangedFiles(repo, { base: "HEAD" }),
    /Git does not support rev-parse --end-of-options/,
  );
  assert.equal(trace.calls().filter((args) => args[0] === "diff").length, 0);
});
```

- [ ] **步骤 4：运行红测试**

```bash
node --test --test-name-pattern="comparison|reference|revision|capability" tests/git-evidence.test.mjs
```

预期：FAIL，`resolveComparison` 尚未导出。

### 任务 2：实现一次性 comparison 边界

**文件：**

- 修改：`plugins/frontend-engineering-standard/scripts/lib/git-evidence.mjs`

- [ ] **步骤 1：先实现 capability probe**

在 imports 增加 `node:os`，并在 comparison 常量前加入：

```js
const GIT_END_OF_OPTIONS_SUPPORTED = Object.freeze({
  supported: true,
  message: "Git supports rev-parse --end-of-options",
});
const GIT_END_OF_OPTIONS_UNSUPPORTED = Object.freeze({
  supported: false,
  message: "Git does not support rev-parse --end-of-options",
});

export function probeGitRevParseEndOfOptions() {
  let directory;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-git-capability-"));
    const initialized = spawnSync("git", ["init", "--bare", "-q", directory], { encoding: "utf8" });
    if (initialized.status !== 0) return GIT_END_OF_OPTIONS_UNSUPPORTED;
    const result = spawnSync("git", [
      "rev-parse", "--verify", "--quiet", "--end-of-options", "missing-capability-probe-ref^{commit}",
    ], { cwd: directory, encoding: "utf8" });
    return result.status === 1 ? GIT_END_OF_OPTIONS_SUPPORTED : GIT_END_OF_OPTIONS_UNSUPPORTED;
  } catch {
    return GIT_END_OF_OPTIONS_UNSUPPORTED;
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}
```

- [ ] **步骤 2：加入显式 context、标签校验和 commit 解析**

```js
const COMPARISON_CONTEXT = Symbol("comparisonContext");
const COMMIT_OID = /^[0-9a-f]{40,64}$/i;

function comparisonLabels(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Comparison options must be an object");
  }
  const hasBase = options.base !== undefined;
  const hasHead = options.head !== undefined;
  if (hasHead && !hasBase) throw new Error("--head requires --base");
  if (hasBase && (typeof options.base !== "string" || options.base.trim() === "" || options.base.includes("\0"))) {
    throw new Error("Invalid base revision");
  }
  if (hasHead && (typeof options.head !== "string" || options.head.trim() === "" || options.head.includes("\0"))) {
    throw new Error("Invalid head revision");
  }
  const baseLabel = hasBase ? options.base : "HEAD";
  const headLabel = hasHead ? options.head : "working-tree";
  return { baseLabel, headLabel, includeWorkingTree: !hasHead, displayRange: `${baseLabel}..${headLabel}` };
}

function resolveCommit(repository, label, role) {
  const result = runGit(repository, [
    "rev-parse", "--verify", "--quiet", "--end-of-options", `${label}^{commit}`,
  ], { allowFailure: true });
  const oid = result.stdout.trim();
  if (result.status !== 0 || !COMMIT_OID.test(oid)) throw new Error(`Invalid ${role} revision`);
  return oid;
}

function createComparisonSnapshot(repository, options) {
  const labels = comparisonLabels(options);
  const capability = probeGitRevParseEndOfOptions();
  if (!capability.supported) throw new Error(capability.message);
  const baseOid = resolveCommit(repository, labels.baseLabel, "base");
  const headOid = labels.includeWorkingTree
    ? null
    : labels.headLabel === labels.baseLabel
      ? baseOid
      : resolveCommit(repository, labels.headLabel, "head");
  return Object.freeze({ ...labels, baseOid, headOid });
}

function readComparisonContext(repository, options) {
  const state = options?.[COMPARISON_CONTEXT];
  if (!state) return null;
  const resolved = path.resolve(repository);
  if (state.repository !== resolved) {
    throw new Error("Comparison context belongs to a different repository");
  }
  return state;
}

export function createComparisonContext(repository, options = {}) {
  const resolved = path.resolve(repository);
  const existing = readComparisonContext(resolved, options);
  if (existing) return options;
  const snapshot = createComparisonSnapshot(resolved, options);
  const context = { ...options };
  Object.defineProperty(context, COMPARISON_CONTEXT, {
    value: Object.freeze({ repository: resolved, snapshot }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(context);
}

export function resolveComparison(repository, options = {}) {
  const resolved = path.resolve(repository);
  const existing = readComparisonContext(resolved, options);
  return existing?.snapshot ?? createComparisonSnapshot(resolved, options);
}

function diffRangeArgs(comparison) {
  return comparison.includeWorkingTree
    ? [comparison.baseOid]
    : [comparison.baseOid, comparison.headOid];
}

export function describeRange(options = {}) {
  return options?.[COMPARISON_CONTEXT]?.snapshot.displayRange
    ?? comparisonLabels(options).displayRange;
}
```

在四个收集函数入口统一使用：

```js
const comparison = resolveComparison(repo, options);
const range = diffRangeArgs(comparison);
```

删除旧 `diffRangeArgs({ base, head })`。

- [ ] **步骤 3：运行 revision 测试**

```bash
node --test --test-name-pattern="comparison|reference|revision|capability" tests/git-evidence.test.mjs
```

预期：PASS；同一 context 内所有 diff 只接收同一组 OID，复用原始 options 创建下一份报告时重新解析移动引用。

### 任务 3：写敏感路径和内容命令红测试

**文件：**

- 修改：`tests/git-evidence.test.mjs`

- [ ] **步骤 1：加入凭据路径匹配测试**

```js
test("credential path families are matched case-insensitively", () => {
  const sensitive = [
    ".env", ".ENV.production", "config/.npmrc", "config/.YARNRC", "config/.YARNRC.YML",
    ".PyPiRC", ".NETRC", "_NETRC", ".SSH/id_rsa", ".AWS/credentials", ".Azure/profile.json",
    ".KUBE/config", ".docker/config.json", ".CONFIG/GCLOUD/application_default_credentials.json",
    ".config/GH/HOSTS.YML", "certificates/client.crt", "keys/client.key",
    "auth/credentials.json", "auth/Secrets/token.json",
  ];
  for (const file of sensitive) assert.equal(isSensitivePath(file), true, file);
  for (const file of ["src/environment.ts", "src/secretary.ts", "docs/npmrc-guide.md", ".docker/readme.md"]) {
    assert.equal(isSensitivePath(file), false, file);
  }
});
```

- [ ] **步骤 2：加入敏感路径不得进入内容 diff 的测试**

```js
test("tracked and untracked secrets never reach content-level diff", (t) => {
  const repo = createTestRepository({
    ".env.production": "TOKEN=old\n",
    ".NPMRC": "token=old\n",
    ".SSH/id_rsa": "old-private-key\n",
    ".docker/config.json": "{\"auth\":\"old\"}\n",
    "src/safe.ts": "export const value = 1;\n",
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    ".env.production": "TOKEN=tracked-secret\n",
    ".NPMRC": "token=tracked-npm-secret\n",
    ".SSH/id_rsa": "tracked-private-key\n",
    ".AWS/credentials": "untracked-aws-secret\n",
    "src/safe.ts": "export const value = 2;\n",
  });
  const trace = installGitTrace(t);
  const changedFiles = collectChangedFiles(repo);
  const changedLines = collectChangedLines(repo);
  const safeDiff = collectSafeDiff(repo);
  const nonWhitespaceDiff = collectNonWhitespaceDiff(repo);
  assert.deepEqual(changedFiles, [{ status: "M", file: "src/safe.ts" }]);
  const evidence = JSON.stringify({ changedLines, safeDiff, nonWhitespaceDiff });
  for (const secret of ["tracked-secret", "tracked-npm-secret", "tracked-private-key", "untracked-aws-secret"]) {
    assert.ok(!evidence.includes(secret), secret);
  }
  const contentCalls = trace.calls().filter((args) => args[0] === "diff" && !args.includes("--name-status"));
  assert.ok(contentCalls.length > 0);
  for (const args of contentCalls) {
    assert.ok(args.includes("--no-ext-diff"));
    assert.ok(args.includes("--no-textconv"));
    const pathspecs = args.slice(args.indexOf("--") + 1);
    assert.ok(pathspecs.length > 0);
    assert.ok(pathspecs.every((item) => item === ":(top,literal)src/safe.ts"));
  }
});

test("an all-sensitive change runs no content-level diff", (t) => {
  const repo = createTestRepository({ ".env": "TOKEN=old\n" });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, { ".env": "TOKEN=new-secret\n" });
  const trace = installGitTrace(t);
  assert.deepEqual(collectChangedFiles(repo), []);
  assert.deepEqual(collectChangedLines(repo), []);
  assert.equal(collectSafeDiff(repo), "");
  assert.equal(collectNonWhitespaceDiff(repo), "");
  assert.equal(trace.calls().filter((args) => args[0] === "diff" && !args.includes("--name-status")).length, 0);
});

test("sensitive paths stay excluded in an explicit base and head comparison", (t) => {
  const repo = createTestRepository({
    ".NPMRC": "token=old\n",
    "src/safe.ts": "export const value = 1;\n",
  });
  t.after(() => removeTestRepository(repo));
  const base = git(repo, ["rev-parse", "HEAD"]);
  writeFiles(repo, {
    ".NPMRC": "token=committed-secret\n",
    "src/safe.ts": "export const value = 2;\n",
  });
  const head = commitAll(repo, "explicit head");
  writeFiles(repo, {
    ".NPMRC": "token=working-tree-secret\n",
    "src/safe.ts": "export const value = 999;\n",
  });

  const trace = installGitTrace(t);
  const options = createComparisonContext(repo, { base, head });
  assert.deepEqual(collectChangedFiles(repo, options), [{ status: "M", file: "src/safe.ts" }]);
  const diff = collectSafeDiff(repo, options);
  assert.ok(diff.includes("value = 2"));
  assert.ok(!diff.includes("value = 999"));
  assert.ok(!diff.includes("committed-secret"));
  assert.ok(!diff.includes("working-tree-secret"));

  for (const args of trace.calls().filter((item) => item[0] === "diff" && !item.includes("--name-status"))) {
    assert.ok(args.includes(base));
    assert.ok(args.includes(head));
    assert.deepEqual(args.slice(args.indexOf("--") + 1), [":(top,literal)src/safe.ts"]);
  }
});
```

- [ ] **步骤 3：运行红测试**

```bash
node --test --test-name-pattern="credential|secret|sensitive" tests/git-evidence.test.mjs
```

预期：FAIL，新增路径尚未过滤，内容 diff 缺少 `--no-textconv`。

### 任务 4：实现安全 pathspec 内容收集

**文件：**

- 修改：`plugins/frontend-engineering-standard/scripts/lib/git-evidence.mjs`

- [ ] **步骤 1：替换敏感路径分类**

```js
const SENSITIVE_BASENAMES = new Set([".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", ".netrc", "_netrc"]);
const SENSITIVE_DIRECTORY_NAMES = new Set([".ssh", ".aws", ".azure", ".kube"]);
const SENSITIVE_FILE_EXTENSIONS = new Set([
  "pem", "key", "crt", "cer", "der", "p7b", "p7c", "p8", "p10", "csr", "p12", "pfx", "jks", "keystore",
]);

export function isSensitivePath(file) {
  if (typeof file !== "string") return false;
  const normalized = file.replaceAll("\\", "/").replace(/^\.\/+/, "").toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  if (/^\.env(?:\.|$)/.test(basename)) return true;
  if (SENSITIVE_BASENAMES.has(basename)) return true;
  if (segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment))) return true;
  if (segments.some((segment) => /^(?:credentials|secrets?)(?:\.|$)/.test(segment))) return true;
  const extension = basename.match(/\.([^.]+)$/)?.[1];
  if (extension && SENSITIVE_FILE_EXTENSIONS.has(extension)) return true;
  const rooted = `/${normalized}`;
  return rooted.endsWith("/.docker/config.json")
    || rooted.includes("/.config/gcloud/")
    || rooted.endsWith("/.config/gh/hosts.yml");
}

function safeRepositoryPath(file) {
  if (typeof file !== "string" || file === "" || file.includes("\0") || file.includes("\\") || path.posix.isAbsolute(file)) return null;
  const segments = file.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  if (isSensitivePath(file) || isGeneratedPath(file)) return null;
  return file;
}
```

- [ ] **步骤 2：让普通文件读取复用安全路径**

在 `readRepositoryTextFile` 首行加入：

```js
const safeFile = safeRepositoryPath(file);
if (safeFile === null) return null;
```

随后所有路径拼接使用 `safeFile` 而不是原始 `file`。

- [ ] **步骤 3：加入安全 changed-file 状态和内容批次 helper**

```js
const CONTENT_DIFF_BATCH_SIZE = 128;

function literalPathspec(file) {
  return `:(top,literal)${file}`;
}

function collectChangedFileState(repo, options) {
  const comparison = resolveComparison(repo, options);
  const range = diffRangeArgs(comparison);
  const tracked = runGit(repo, ["diff", "--name-status", "-z", "--no-renames", ...range, "--"]);
  const fields = tracked.stdout.split("\0").filter(Boolean);
  const files = new Map();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const safeFile = safeRepositoryPath(fields[index + 1]);
    if (safeFile !== null) files.set(safeFile, { status: fields[index][0], file: safeFile });
  }
  const untrackedFiles = new Set();
  if (comparison.includeWorkingTree) {
    const untracked = runGit(repo, ["ls-files", "--others", "--exclude-standard", "-z", "--"]);
    for (const candidate of untracked.stdout.split("\0").filter(Boolean)) {
      const safeFile = safeRepositoryPath(candidate);
      if (safeFile === null || readRepositoryTextFile(repo, safeFile) === null) continue;
      if (!files.has(safeFile)) {
        files.set(safeFile, { status: "A", file: safeFile });
        untrackedFiles.add(safeFile);
      }
    }
  }
  return {
    comparison,
    files: [...files.values()].sort((left, right) => left.file.localeCompare(right.file)),
    untrackedFiles,
  };
}

function runContentDiffBatches(repo, comparison, diffOptions, files, { batchSize = CONTENT_DIFF_BATCH_SIZE } = {}) {
  if (files.length === 0) return [];
  const outputs = [];
  const range = diffRangeArgs(comparison);
  for (let index = 0; index < files.length; index += batchSize) {
    const batch = files.slice(index, index + batchSize);
    const result = runGit(repo, [
      "diff", ...diffOptions, "--no-ext-diff", "--no-textconv", ...range, "--", ...batch.map(literalPathspec),
    ], { redactStdout: true });
    outputs.push(result.stdout);
  }
  return outputs;
}
```

- [ ] **步骤 4：重写四个收集函数**

`collectChangedFiles` 直接返回 `collectChangedFileState(repo, options).files`。`collectChangedLines` 对 tracked files 批量运行 `--unified=0`，对 untracked files 使用 `readRepositoryTextFile`；`collectSafeDiff` 和 `collectNonWhitespaceDiff` 对每个安全 tracked file 使用 `runContentDiffBatches(..., {batchSize:1})`，对安全 untracked file继续使用受限普通文件读取。不得再对未过滤的整个 range 执行内容 diff。

- [ ] **步骤 5：运行敏感路径测试**

```bash
node --test --test-name-pattern="credential|secret|sensitive" tests/git-evidence.test.mjs
```

预期：PASS。

### 任务 5：实现 stdout 脱敏并补齐 capability 回归断言

**文件：**

- 修改：`tests/git-evidence.test.mjs`
- 修改：`plugins/frontend-engineering-standard/scripts/lib/git-evidence.mjs`

- [ ] **步骤 1：增加错误与 capability 红测试**

```js
test("content diff failures never echo stdout", (t) => {
  const repo = createTestRepository({ "src/value.ts": "export const value = 1;\n" });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, { "src/value.ts": "export const value = 2;\n" });
  installGitTrace(t);
  process.env.AI_MARKETPLACE_FAIL_CONTENT = "1";
  process.env.AI_MARKETPLACE_LEAK_TEXT = "raw-sensitive-diff-output";
  assert.throws(() => collectSafeDiff(repo), (error) => {
    assert.ok(error.message.includes("git diff"));
    assert.ok(!error.message.includes("raw-sensitive-diff-output"));
    return true;
  });
});

test("Git rev-parse end-of-options capability probe is immutable", () => {
  const result = probeGitRevParseEndOfOptions();
  assert.deepEqual(result, {
    supported: true,
    message: "Git supports rev-parse --end-of-options",
  });
  assert.ok(Object.isFrozen(result));
});
```

- [ ] **步骤 2：运行红测试**

```bash
node --test --test-name-pattern="failures|capability" tests/git-evidence.test.mjs
```

预期：FAIL，stdout 仍可能进入错误；任务 2 已实现的 probe 回归断言保持 PASS。

- [ ] **步骤 3：扩展 runGit 错误策略**

```js
export function runGit(repo, args, { allowFailure = false, redactStdout = false } = {}) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) {
    const diagnostic = (result.stderr || (!redactStdout ? result.stdout : "") || result.error?.message || "").trim();
    throw new Error(`git ${args.join(" ")} failed${diagnostic ? `: ${diagnostic}` : ""}`);
  }
  return result;
}
```

- [ ] **步骤 4：运行测试转绿**

```bash
node --test tests/git-evidence.test.mjs
```

预期：全部 PASS。

### 任务 6：验证调用链兼容与文件边界

**文件：** 本计划两个文件

- [ ] **步骤 1：运行调用链基线**

```bash
node --test tests/rules.test.mjs tests/impact.test.mjs tests/review-context.test.mjs tests/compatibility-baseline.test.mjs
```

预期：全部 PASS；字段、range、严重级别和正常输入行为不变。本步骤只验证兼容性；三个报告入口的一次性 context 接线由总控计划在并行 barrier 后完成。

- [ ] **步骤 2：运行空白与语法检查**

```bash
git diff --check -- \
  plugins/frontend-engineering-standard/scripts/lib/git-evidence.mjs \
  tests/git-evidence.test.mjs
```

预期：无空白错误。全仓 `npm test` 由主代理在三路停止写入后统一执行，避免读取其他代理的半成品。

- [ ] **步骤 3：确认唯一写入范围**

```bash
git status --short -- \
  plugins/frontend-engineering-standard/scripts/lib/git-evidence.mjs \
  tests/git-evidence.test.mjs
```

预期本工作流只新增或修改：

```text
plugins/frontend-engineering-standard/scripts/lib/git-evidence.mjs
tests/git-evidence.test.mjs
```

该命令只报告本工作流授权路径；共享 worktree 的全局变更由主代理在 barrier 后按三个工作流授权路径的并集审计。
