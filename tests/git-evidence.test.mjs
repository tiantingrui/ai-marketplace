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
  readRepositoryTextFile,
  resolveComparison,
  runGit,
} from "../plugins/frontend-engineering-standard/scripts/lib/git-evidence.mjs";
import {
  commitFiles,
  createTestRepository,
  git,
  removeTestRepository,
  writeFiles,
} from "./test-repository.mjs";

const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

function withGitWrapper(mode, callback) {
  const wrapperDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "git-evidence-path-wrapper-"));
  const wrapper = path.join(wrapperDirectory, "git");
  const log = path.join(wrapperDirectory, "calls.log");
  fs.writeFileSync(wrapper, `#!/bin/sh
{
  printf 'cwd=%s' "$PWD"
  for argument in "$@"; do printf '\\t%s' "$argument"; done
  printf '\\n'
} >> "$GIT_EVIDENCE_LOG"
if [ "$GIT_EVIDENCE_WRAPPER_MODE" = "unsupported" ] && [ "$1" = "rev-parse" ]; then
  for argument in "$@"; do
    if [ "$argument" = "--end-of-options" ]; then
      printf '%s\\n' 'unknown option: --end-of-options' >&2
      exit 129
    fi
  done
fi
if [ "$GIT_EVIDENCE_WRAPPER_MODE" = "probe-status-zero" ] && [ "$1" = "rev-parse" ]; then
  for argument in "$@"; do
    if [ "$argument" = "--end-of-options" ]; then
      printf '%s\\n' '0000000000000000000000000000000000000000'
      exit 0
    fi
  done
fi
if [ "$GIT_EVIDENCE_WRAPPER_MODE" = "invalid-name-status" ] && [ "$1" = "diff" ] && [ "$2" = "--name-status" ]; then
  printf 'M\\000src/invalid-\\200.js\\000'
  exit 0
fi
if [ "$GIT_EVIDENCE_WRAPPER_MODE" = "discovery-name-failure" ] && [ "$1" = "diff" ] && [ "$2" = "--name-status" ]; then
  counter=0
  while [ "$counter" -lt 1024 ]; do
    printf '%s' 'DISCOVERY-NAME-STDOUT-SECRET-MARKER'
    counter=$((counter + 1))
  done
  exit 11
fi
if [ "$GIT_EVIDENCE_WRAPPER_MODE" = "discovery-ls-failure" ] && [ "$1" = "ls-files" ]; then
  printf '%s' 'DISCOVERY-LS-STDOUT-SECRET-MARKER'
  printf '%s\\n' 'ls-files diagnostic' >&2
  exit 12
fi
if [ "$GIT_EVIDENCE_WRAPPER_MODE" = "spawn-maxbuffer" ] && [ "$1" = "status" ]; then
  head -c 22000000 /dev/zero
  exit 13
fi
if [ "$1" = "diff" ] && [ "$2" != "--name-status" ]; then
  if [ "$GIT_EVIDENCE_WRAPPER_MODE" = "content-failure-stdout" ]; then
    printf '%s\\n' 'STDOUT-ONLY-SECRET-MARKER'
    exit 9
  fi
  if [ "$GIT_EVIDENCE_WRAPPER_MODE" = "content-failure-stderr" ]; then
    printf '%s\\n' 'STDOUT-SECRET-MARKER'
    printf '%s\\n' 'content diff diagnostic' >&2
    exit 9
  fi
fi
exec "$GIT_EVIDENCE_REAL_GIT" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(log, "");
  const previous = {
    PATH: process.env.PATH,
    realGit: process.env.GIT_EVIDENCE_REAL_GIT,
    log: process.env.GIT_EVIDENCE_LOG,
    mode: process.env.GIT_EVIDENCE_WRAPPER_MODE,
  };
  process.env.PATH = `${wrapperDirectory}${path.delimiter}${previous.PATH}`;
  process.env.GIT_EVIDENCE_REAL_GIT = REAL_GIT;
  process.env.GIT_EVIDENCE_LOG = log;
  process.env.GIT_EVIDENCE_WRAPPER_MODE = mode;
  try {
    return callback({
      clearCalls: () => fs.writeFileSync(log, ""),
      readCalls: () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    });
  } finally {
    process.env.PATH = previous.PATH;
    for (const [name, value] of [
      ["GIT_EVIDENCE_REAL_GIT", previous.realGit],
      ["GIT_EVIDENCE_LOG", previous.log],
      ["GIT_EVIDENCE_WRAPPER_MODE", previous.mode],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(wrapperDirectory, { recursive: true, force: true });
  }
}

function parseCall(call) {
  const [cwd, ...args] = call.split("\t");
  return { cwd: cwd.slice(4), args };
}

function withFileSwapAfterRealpath({
  file,
  externalFile,
  marker,
  safeContent,
  restoreAfterRead = false,
}, callback) {
  const originalRealpathSync = fs.realpathSync;
  const originalReadFileSync = fs.readFileSync;
  const absolute = originalRealpathSync(path.resolve(file));
  let sequence = 0;
  let markerRead = false;

  function replaceAtomically(createReplacement) {
    const replacement = `${absolute}.swap-${process.pid}-${sequence}`;
    sequence += 1;
    createReplacement(replacement);
    fs.renameSync(replacement, absolute);
  }

  fs.realpathSync = function swappedRealpathSync(candidate, ...args) {
    const real = originalRealpathSync.call(fs, candidate, ...args);
    if (real === absolute && !fs.lstatSync(absolute).isSymbolicLink()) {
      replaceAtomically((replacement) => fs.symlinkSync(externalFile, replacement));
    }
    return real;
  };
  fs.readFileSync = function swappedReadFileSync(candidate, ...args) {
    const content = originalReadFileSync.call(fs, candidate, ...args);
    if (
      (Buffer.isBuffer(content) && content.includes(Buffer.from(marker)))
      || (typeof content === "string" && content.includes(marker))
    ) {
      markerRead = true;
    }
    if (
      restoreAfterRead
      && typeof candidate !== "number"
      && path.resolve(String(candidate)) === absolute
      && fs.lstatSync(absolute).isSymbolicLink()
    ) {
      replaceAtomically((replacement) => fs.writeFileSync(replacement, safeContent));
    }
    return content;
  };

  try {
    return { value: callback(), markerRead };
  } finally {
    fs.realpathSync = originalRealpathSync;
    fs.readFileSync = originalReadFileSync;
  }
}

function snapshotKeys(snapshot) {
  return Object.keys(snapshot).sort();
}

test("the rev-parse capability probe is isolated, supported, and frozen", () => {
  const result = probeGitRevParseEndOfOptions();

  assert.deepEqual(result, {
    supported: true,
    message: "Git supports rev-parse --end-of-options",
  });
  assert.equal(Object.isFrozen(result), true);
});

test("the capability probe requires missing-ref status 1 rather than any successful invocation", () => {
  withGitWrapper("probe-status-zero", () => {
    assert.deepEqual(probeGitRevParseEndOfOptions(), {
      supported: false,
      message: "Git does not support rev-parse --end-of-options",
    });
  });
});

test("unsupported rev-parse capability fails before touching or diffing the target repository", (t) => {
  const repo = createTestRepository({ "src/value.js": "export const value = 1;\n" });
  t.after(() => removeTestRepository(repo));

  withGitWrapper("unsupported", ({ readCalls }) => {
    const capability = probeGitRevParseEndOfOptions();
    assert.deepEqual(capability, {
      supported: false,
      message: "Git does not support rev-parse --end-of-options",
    });
    assert.equal(Object.isFrozen(capability), true);
    assert.throws(() => collectChangedFiles(repo), { message: capability.message });

    const calls = readCalls();
    assert.ok(calls.some((call) => call.includes("\trev-parse\t") && call.includes("\t--end-of-options\t")));
    assert.ok(!calls.some((call) => call.startsWith(`cwd=${repo}\t`)));
    assert.ok(!calls.some((call) => call.includes("\tdiff\t")));
    for (const call of calls.filter((item) => item.includes("\trev-parse\t"))) {
      const cwd = call.slice(4, call.indexOf("\t"));
      assert.equal(fs.existsSync(cwd), false);
    }
  });
});

test("comparison snapshots resolve branch, lightweight tag, annotated tag, and OID inputs", (t) => {
  const repo = createTestRepository({ "src/value.js": "export const value = 1;\n" });
  t.after(() => removeTestRepository(repo));
  const first = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["branch", "base-branch", first]);
  git(repo, ["tag", "lightweight", first]);
  const second = commitFiles(repo, { "src/value.js": "export const value = 2;\n" });
  git(repo, ["tag", "-a", "annotated", "-m", "annotated", second]);

  const branchToAnnotated = resolveComparison(repo, { base: "base-branch", head: "annotated" });
  assert.deepEqual(snapshotKeys(branchToAnnotated), [
    "baseLabel",
    "baseOid",
    "displayRange",
    "headLabel",
    "headOid",
    "includeWorkingTree",
  ]);
  assert.deepEqual(branchToAnnotated, {
    baseLabel: "base-branch",
    headLabel: "annotated",
    baseOid: first,
    headOid: second,
    includeWorkingTree: false,
    displayRange: "base-branch..annotated",
  });
  assert.equal(Object.isFrozen(branchToAnnotated), true);

  assert.equal(resolveComparison(repo, { base: "lightweight" }).baseOid, first);
  assert.equal(resolveComparison(repo, { base: first, head: second }).headOid, second);
  assert.deepEqual(resolveComparison(repo), {
    baseLabel: "HEAD",
    headLabel: "working-tree",
    baseOid: second,
    headOid: null,
    includeWorkingTree: true,
    displayRange: "HEAD..working-tree",
  });
});

test("identical base and head labels share one immutable OID resolution", (t) => {
  const repo = createTestRepository({ "src/value.js": "export const value = 1;\n" });
  t.after(() => removeTestRepository(repo));

  withGitWrapper("record", ({ readCalls }) => {
    const comparison = resolveComparison(repo, { base: "HEAD", head: "HEAD" });
    assert.equal(comparison.baseOid, comparison.headOid);
    const labelResolutions = readCalls()
      .map(parseCall)
      .filter((call) => call.args.at(-1) === "HEAD^{commit}");
    assert.equal(labelResolutions.length, 1);
  });
});

test("a frozen comparison context clones options and pins a moving ref for its lifetime", (t) => {
  const repo = createTestRepository({ "src/value.js": "export const value = 1;\n" });
  const otherRepo = createTestRepository({ "src/other.js": "export const other = 1;\n" });
  t.after(() => {
    removeTestRepository(repo);
    removeTestRepository(otherRepo);
  });
  const first = git(repo, ["rev-parse", "HEAD"]);
  const second = commitFiles(repo, { "src/value.js": "export const value = 2;\n" });
  git(repo, ["update-ref", "refs/heads/moving", first]);
  const rawOptions = { base: "moving", requirement: "keep me" };

  const context = createComparisonContext(repo, rawOptions);
  const pinned = resolveComparison(repo, context);
  assert.notEqual(context, rawOptions);
  assert.deepEqual(context, rawOptions);
  assert.equal(Object.isFrozen(context), true);
  assert.deepEqual(Object.keys(context), ["base", "requirement"]);
  assert.equal(Object.getOwnPropertySymbols(context).length, 1);
  assert.equal(Object.getOwnPropertyDescriptor(context, Object.getOwnPropertySymbols(context)[0]).enumerable, false);
  assert.equal(pinned.baseOid, first);

  git(repo, ["update-ref", "refs/heads/moving", second]);
  assert.equal(resolveComparison(repo, context), pinned);
  assert.equal(resolveComparison(repo, context).baseOid, first);
  assert.equal(resolveComparison(repo, createComparisonContext(repo, rawOptions)).baseOid, second);
  assert.throws(() => resolveComparison(otherRepo, context), /different repository/i);
});

test("comparison validation rejects missing, empty, NUL, invalid, blob, and tree revisions", (t) => {
  const repo = createTestRepository({ "src/value.js": "export const value = 1;\n" });
  t.after(() => removeTestRepository(repo));
  const blob = git(repo, ["rev-parse", "HEAD:src/value.js"]);
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);

  assert.throws(() => resolveComparison(repo, { head: "HEAD" }), {
    message: "--head requires --base",
  });
  for (const base of ["", "   ", null, 42, "HEAD\0tail", "missing", blob, tree]) {
    assert.throws(() => resolveComparison(repo, { base }), { message: "Invalid base revision" });
  }
  for (const head of ["", "   ", null, 42, "HEAD\0tail", "missing", blob, tree]) {
    assert.throws(() => resolveComparison(repo, { base: "HEAD", head }), { message: "Invalid head revision" });
  }
  for (const options of [null, [], "HEAD"]) {
    assert.throws(() => resolveComparison(repo, options), { message: "Comparison options must be an object" });
  }
  assert.throws(() => describeRange({ base: "" }), { message: "Invalid base revision" });
});

test("option-shaped refs resolve only through guarded rev-parse and retain their display labels", (t) => {
  const repo = createTestRepository({ "src/value.js": "export const value = 1;\n" });
  t.after(() => removeTestRepository(repo));
  const first = git(repo, ["rev-parse", "HEAD"]);
  const second = commitFiles(repo, { "src/value.js": "export const value = 2;\n" });
  git(repo, ["update-ref", "refs/heads/-base", first]);
  git(repo, ["update-ref", "refs/heads/--head", second]);

  const comparison = resolveComparison(repo, { base: "-base", head: "--head" });
  assert.deepEqual(comparison, {
    baseLabel: "-base",
    headLabel: "--head",
    baseOid: first,
    headOid: second,
    includeWorkingTree: false,
    displayRange: "-base..--head",
  });
  assert.equal(describeRange(createComparisonContext(repo, { base: "-base", head: "--head" })), "-base..--head");
});

test("sensitive path matching is case-insensitive and covers credentials and key material", () => {
  const sensitive = [
    ".env",
    ".ENV.production",
    "config/.envrc",
    ".npmrc",
    "nested/.NPMRC",
    ".yarnrc",
    ".YARNRC.YML",
    ".pypirc",
    ".NETRC",
    "_netrc",
    ".GIT-CREDENTIALS",
    ".authinfo",
    ".AUTHINFO.GPG",
    "home/.ssh/id_rsa",
    "home\\.SSH\\id_ed25519",
    "home/.AWS/credentials",
    "home/.azure/profile.json",
    "home/.KUBE/config",
    "home/.docker/config.json",
    "home/.CONFIG/GCLOUD/application_default_credentials.json",
    "home/.config/gh/HOSTS.YML",
    "config/credentials.json",
    "config/SECRET.yaml",
    "secrets/token.txt",
    ...["pem", "key", "crt", "cer", "der", "p7b", "p7c", "p8", "p10", "csr", "p12", "pfx", "jks", "keystore"]
      .map((extension) => `certificates/private.${extension.toUpperCase()}`),
  ];
  for (const file of sensitive) assert.equal(isSensitivePath(file), true, file);

  for (const file of [
    "src/environment.ts",
    "src/secretary.ts",
    "home/.docker/daemon.json",
    "home/.config/gh/config.yml",
    "certificates/keynote.txt",
  ]) {
    assert.equal(isSensitivePath(file), false, file);
  }
});

test("repository text reads require a safe POSIX relative regular file inside the repository", (t) => {
  const repo = createTestRepository({
    "dir/file.txt": "safe text\n",
    "binary.txt": "prefix\0suffix",
    "large.txt": "12345",
    ".env": "SECRET=must-not-read\n",
    "dist/generated.txt": "generated text\n",
  });
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "git-evidence-outside-"));
  const externalFile = path.join(externalDirectory, "outside.txt");
  fs.writeFileSync(externalFile, "outside secret\n");
  fs.writeFileSync(path.join(repo, "bad\\name.txt"), "backslash path\n");
  fs.symlinkSync(path.join(repo, "dir/file.txt"), path.join(repo, "linked-inside.txt"));
  fs.symlinkSync(externalFile, path.join(repo, "linked-outside.txt"));
  fs.symlinkSync(externalDirectory, path.join(repo, "outside-directory"));
  t.after(() => {
    removeTestRepository(repo);
    fs.rmSync(externalDirectory, { recursive: true, force: true });
  });

  assert.equal(readRepositoryTextFile(repo, "dir/file.txt"), "safe text\n");
  assert.equal(readRepositoryTextFile(repo, "large.txt", { maxBytes: 4 }), null);
  assert.equal(readRepositoryTextFile(repo, "binary.txt"), null);
  assert.equal(readRepositoryTextFile(repo, ".env"), null);
  assert.equal(readRepositoryTextFile(repo, "dist/generated.txt"), null);
  assert.equal(readRepositoryTextFile(repo, "linked-inside.txt"), null);
  assert.equal(readRepositoryTextFile(repo, "linked-outside.txt"), null);
  assert.equal(readRepositoryTextFile(repo, "outside-directory/outside.txt"), null);

  for (const unsafe of [
    "bad\\name.txt",
    "dir//file.txt",
    "./dir/file.txt",
    "dir/./file.txt",
    "dir/child/../file.txt",
    path.join(repo, "dir/file.txt"),
    "dir/file.txt\0tail",
  ]) {
    assert.equal(readRepositoryTextFile(repo, unsafe), null, unsafe);
  }
});

test("repository text reads reject a file swapped to an external symlink after realpath", (t) => {
  const repo = createTestRepository({ "placeholder.txt": "tracked\n" });
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "git-evidence-swap-outside-"));
  const externalFile = path.join(externalDirectory, "outside.txt");
  const file = "src/untracked.txt";
  const absolute = path.join(repo, file);
  const safeContent = "safe-untracked-content\n";
  writeFiles(repo, { [file]: safeContent });
  fs.writeFileSync(externalFile, "external-swap-marker\n");
  t.after(() => {
    removeTestRepository(repo);
    fs.rmSync(externalDirectory, { recursive: true, force: true });
  });

  const { value: content, markerRead } = withFileSwapAfterRealpath({
    file: absolute,
    externalFile,
    marker: "external-swap-marker",
    safeContent,
  }, () => readRepositoryTextFile(repo, file));
  assert.equal(content, null);
  assert.equal(markerRead, false);
});

test("swapped untracked files never enter Git evidence", (t) => {
  const repo = createTestRepository({ "placeholder.txt": "tracked\n" });
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "git-evidence-evidence-swap-outside-"));
  const externalFile = path.join(externalDirectory, "outside.txt");
  const file = "src/untracked.txt";
  const absolute = path.join(repo, file);
  const safeContent = "safe-untracked-content\n";
  writeFiles(repo, { [file]: safeContent });
  fs.writeFileSync(externalFile, "external-evidence-marker\n");
  t.after(() => {
    removeTestRepository(repo);
    fs.rmSync(externalDirectory, { recursive: true, force: true });
  });
  const context = createComparisonContext(repo);

  const { value: evidence, markerRead } = withFileSwapAfterRealpath({
    file: absolute,
    externalFile,
    marker: "external-evidence-marker",
    safeContent,
    restoreAfterRead: true,
  }, () => {
    const lines = collectChangedLines(repo, context);
    const safeDiff = collectSafeDiff(repo, context);
    const nonWhitespaceDiff = collectNonWhitespaceDiff(repo, context);
    const files = collectChangedFiles(repo, context);
    return { lines, safeDiff, nonWhitespaceDiff, files };
  });
  assert.equal(markerRead, false);
  assert.deepEqual(evidence.lines, []);
  assert.equal(evidence.safeDiff, "");
  assert.equal(evidence.nonWhitespaceDiff, "");
  assert.deepEqual(evidence.files, []);
  for (const output of [JSON.stringify(evidence.lines), evidence.safeDiff, evidence.nonWhitespaceDiff]) {
    assert.ok(!output.includes("external-evidence-marker"));
  }
});

test("control-character repository paths are excluded before evidence serialization", (t) => {
  const tracked = "src/line\nbreak.js";
  const untracked = "src/tab\tfile.js";
  const bidiTracked = [
    "src/arabic-mark-\u061Cname.js",
    "src/ltr-mark-\u200Ename.js",
    "src/rtl-mark-\u200Fname.js",
    "src/bidi-\u202Ecod.js",
  ];
  const bidiUntracked = [
    "src/arabic-mark-untracked-\u061Cname.js",
    "src/ltr-mark-untracked-\u200Ename.js",
    "src/rtl-mark-untracked-\u200Fname.js",
    "src/isolate-\u2066name.js",
  ];
  const repo = createTestRepository({
    [tracked]: "export const value = 'old';\n",
    ...Object.fromEntries(bidiTracked.map((file) => [file, "export const value = 'old';\n"])),
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    [tracked]: "export const value = 'tracked-injection';\n",
    [untracked]: "export const value = 'untracked-injection';\n",
    ...Object.fromEntries(bidiTracked.map((file) => [file, "export const value = 'bidi-tracked-injection';\n"])),
    ...Object.fromEntries(bidiUntracked.map((file) => [file, "export const value = 'bidi-untracked-injection';\n"])),
  });

  for (const file of [tracked, untracked, ...bidiTracked, ...bidiUntracked]) {
    assert.equal(readRepositoryTextFile(repo, file), null);
  }
  withGitWrapper("record", ({ clearCalls, readCalls }) => {
    const context = createComparisonContext(repo);
    clearCalls();
    assert.deepEqual(collectChangedFiles(repo, context), []);
    assert.deepEqual(collectChangedLines(repo, context), []);
    assert.equal(collectSafeDiff(repo, context), "");
    assert.equal(collectNonWhitespaceDiff(repo, context), "");
    assert.ok(!readCalls().map(parseCall).some((call) => call.args[0] === "diff" && call.args[1] !== "--name-status"));
  });
});

test("changed-line parsing decodes Git C-quoted Unicode and quote paths", (t) => {
  const files = ["src/中文.js", "src/emoji-😀.js", "src/quoted\"name.js"];
  const repo = createTestRepository(Object.fromEntries(files.map((file) => [
    file,
    "export const value = 'old';\n",
  ])));
  t.after(() => removeTestRepository(repo));
  git(repo, ["config", "core.quotePath", "true"]);
  writeFiles(repo, Object.fromEntries(files.map((file, index) => [
    file,
    `export const value = 'quoted-new-marker-${index}';\n`,
  ])));

  assert.deepEqual(collectChangedFiles(repo), files
    .map((file) => ({ status: "M", file }))
    .sort((left, right) => left.file.localeCompare(right.file)));
  const lines = collectChangedLines(repo);
  files.forEach((file, index) => {
    assert.ok(lines.some((line) => line.file === file && line.text.includes(`quoted-new-marker-${index}`)));
  });
});

test("invalid UTF-8 discovery paths never alias replacement-character filenames", {
  skip: process.platform === "win32",
}, (t) => {
  const repo = createTestRepository({ "placeholder.txt": "tracked\n" });
  t.after(() => removeTestRepository(repo));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const invalidAbsolute = Buffer.concat([
    Buffer.from(`${repo}${path.sep}src${path.sep}invalid-`),
    Buffer.from([0x80]),
    Buffer.from(".js"),
  ]);
  try {
    fs.writeFileSync(invalidAbsolute, "invalid-old\n");
  } catch (error) {
    if (["EINVAL", "EILSEQ", "EPERM"].includes(error.code)) {
      t.skip(`filesystem rejects invalid UTF-8 filenames (${error.code})`);
      return;
    }
    throw error;
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "track invalid UTF-8 filename"]);
  fs.writeFileSync(invalidAbsolute, "invalid-byte-secret-marker\n");
  const validFile = "src/invalid-\uFFFD.js";
  writeFiles(repo, { [validFile]: "valid-replacement-marker\n" });

  withGitWrapper("record", ({ clearCalls, readCalls }) => {
    const context = createComparisonContext(repo);
    clearCalls();
    assert.deepEqual(collectChangedFiles(repo, context), [{ status: "A", file: validFile }]);
    const lines = collectChangedLines(repo, context);
    const safeDiff = collectSafeDiff(repo, context);
    const nonWhitespaceDiff = collectNonWhitespaceDiff(repo, context);
    assert.ok(lines.some((line) => line.file === validFile && line.text.includes("valid-replacement-marker")));
    assert.ok(safeDiff.includes("valid-replacement-marker"));
    assert.ok(nonWhitespaceDiff.includes(validFile));
    for (const output of [JSON.stringify(lines), safeDiff, nonWhitespaceDiff]) {
      assert.ok(!output.includes("invalid-byte-secret-marker"));
    }
    assert.ok(!readCalls().map(parseCall).some((call) => (
      call.args[0] === "diff" && call.args[1] !== "--name-status"
    )));
  });
});

test("fatal discovery decoding drops invalid bytes before U+FFFD path matching", (t) => {
  const repo = createTestRepository({ "placeholder.txt": "tracked\n" });
  t.after(() => removeTestRepository(repo));
  const validFile = "src/invalid-\uFFFD.js";
  writeFiles(repo, { [validFile]: "valid-replacement-marker\n" });

  withGitWrapper("invalid-name-status", ({ clearCalls, readCalls }) => {
    const context = createComparisonContext(repo);
    clearCalls();
    assert.deepEqual(collectChangedFiles(repo, context), [{ status: "A", file: validFile }]);
    const lines = collectChangedLines(repo, context);
    const diff = collectSafeDiff(repo, context);
    assert.ok(lines.some((line) => line.file === validFile && line.text.includes("valid-replacement-marker")));
    assert.ok(diff.includes("valid-replacement-marker"));
    assert.ok(!readCalls().map(parseCall).some((call) => (
      call.args[0] === "diff" && call.args[1] !== "--name-status"
    )));
  });
});

test("tracked leading-BOM paths retain identity beside an ordinary sibling", (t) => {
  const bomFile = "\uFEFFsrc.js";
  const repo = createTestRepository({
    "src.js": "ordinary-sibling-content\n",
    [bomFile]: "bom-old\n",
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, { [bomFile]: "tracked-bom-marker\n" });

  withGitWrapper("record", ({ clearCalls, readCalls }) => {
    const context = createComparisonContext(repo);
    clearCalls();
    assert.deepEqual(collectChangedFiles(repo, context), [{ status: "M", file: bomFile }]);
    const lines = collectChangedLines(repo, context);
    const safeDiff = collectSafeDiff(repo, context);
    const nonWhitespaceDiff = collectNonWhitespaceDiff(repo, context);
    assert.ok(lines.some((line) => line.file === bomFile && line.text.includes("tracked-bom-marker")));
    for (const output of [JSON.stringify(lines), safeDiff, nonWhitespaceDiff]) {
      assert.ok(output.includes("tracked-bom-marker"));
      assert.ok(!output.includes("ordinary-sibling-content"));
    }
    for (const call of readCalls().map(parseCall).filter((item) => (
      item.args[0] === "diff" && item.args[1] !== "--name-status"
    ))) {
      assert.deepEqual(call.args.slice(call.args.indexOf("--") + 1), [`:(top,literal)${bomFile}`]);
    }
  });
});

test("untracked leading-BOM paths never read an ordinary sibling", (t) => {
  const bomFile = "\uFEFFnotes.js";
  const repo = createTestRepository({ "notes.js": "ordinary-sibling-secret\n" });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, { [bomFile]: "untracked-bom-marker\n" });

  const context = createComparisonContext(repo);
  assert.deepEqual(collectChangedFiles(repo, context), [{ status: "A", file: bomFile }]);
  const lines = collectChangedLines(repo, context);
  const safeDiff = collectSafeDiff(repo, context);
  const nonWhitespaceDiff = collectNonWhitespaceDiff(repo, context);
  assert.ok(lines.some((line) => line.file === bomFile && line.text.includes("untracked-bom-marker")));
  assert.ok(safeDiff.includes("untracked-bom-marker"));
  assert.ok(nonWhitespaceDiff.includes(bomFile));
  for (const output of [JSON.stringify(lines), safeDiff, nonWhitespaceDiff]) {
    assert.ok(!output.includes("ordinary-sibling-secret"));
  }
});

test("content diffs force stable a/b prefixes under repository diff configuration", (t) => {
  const configurations = [
    [["diff.mnemonicPrefix", "true"]],
    [["diff.noprefix", "true"]],
    [["diff.srcPrefix", "custom-source/"], ["diff.dstPrefix", "custom-destination/"]],
  ];

  for (const settings of configurations) {
    const repo = createTestRepository({ "src/value.js": "export const value = 'old';\n" });
    t.after(() => removeTestRepository(repo));
    for (const [key, value] of settings) git(repo, ["config", key, value]);
    writeFiles(repo, { "src/value.js": "export const value = 'stable-prefix-marker';\n" });

    assert.ok(collectChangedLines(repo).some((line) => line.text.includes("stable-prefix-marker")));
    const diff = collectSafeDiff(repo);
    assert.match(diff, /^diff --git a\/src\/value\.js b\/src\/value\.js$/m);
    assert.match(diff, /^--- a\/src\/value\.js$/m);
    assert.match(diff, /^\+\+\+ b\/src\/value\.js$/m);
  }
});

test("runGit reports spawn errors without exposing fabricated stdout", (t) => {
  const repo = createTestRepository({ "src/value.js": "export const value = 1;\n" });
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-evidence-empty-path-"));
  const previousPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = previousPath;
    removeTestRepository(repo);
    fs.rmSync(emptyPath, { recursive: true, force: true });
  });

  process.env.PATH = emptyPath;
  assert.throws(
    () => runGit(repo, ["status"], { redactStdout: true }),
    (error) => error instanceof Error && error.message.includes("ENOENT"),
  );
});

test("discovery failures redact stdout and preserve stderr diagnostics", (t) => {
  const repo = createTestRepository({ "src/value.js": "export const value = 1;\n" });
  t.after(() => removeTestRepository(repo));

  withGitWrapper("discovery-name-failure", () => {
    assert.throws(() => collectChangedFiles(repo), (error) => (
      error instanceof Error
      && error.message.includes("git diff")
      && !error.message.includes("DISCOVERY-NAME-STDOUT-SECRET-MARKER")
      && error.message.length < 2048
    ));
  });
  withGitWrapper("discovery-ls-failure", () => {
    assert.throws(() => collectChangedFiles(repo), (error) => (
      error instanceof Error
      && error.message.includes("ls-files diagnostic")
      && !error.message.includes("DISCOVERY-LS-STDOUT-SECRET-MARKER")
    ));
  });
});

test("runGit prioritizes spawn errors over captured stdout", (t) => {
  const repo = createTestRepository({ "src/value.js": "export const value = 1;\n" });
  t.after(() => removeTestRepository(repo));

  withGitWrapper("spawn-maxbuffer", () => {
    let caught;
    try {
      runGit(repo, ["status"]);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    assert.ok(caught.message.includes("ENOBUFS"));
    assert.ok(caught.message.length < 2048);
  });
});

test("working-tree evidence filters unsafe, generated, and sensitive files before content commands", (t) => {
  const repo = createTestRepository({
    "src/safe.js": "export const safe = 'old';\n",
    ".ENV.production": "TRACKED_SECRET=old\n",
    ".GIT-CREDENTIALS": "https://old-credential\n",
    "bad\\name.js": "export const unsafe = 'old';\n",
    "dist/generated.js": "export const generated = 'old';\n",
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    "src/safe.js": "export const safe = 'safe-new-marker';\n",
    ".ENV.production": "TRACKED_SECRET=tracked-secret-marker\n",
    ".GIT-CREDENTIALS": "https://tracked-git-credential-marker\n",
    "bad\\name.js": "export const unsafe = 'unsafe-path-marker';\n",
    "dist/generated.js": "export const generated = 'generated-marker';\n",
    "src/new.js": "export const added = 'untracked-safe-marker';\n",
    ".npmrc": "//registry.invalid/:_authToken=untracked-secret-marker\n",
    ".authinfo": "machine invalid password untracked-authinfo-marker\n",
    ".AUTHINFO.GPG": "untracked-authinfo-gpg-marker\n",
    "private.PFX": "untracked-key-marker\n",
  });

  withGitWrapper("record", ({ clearCalls, readCalls }) => {
    const context = createComparisonContext(repo);
    const comparison = resolveComparison(repo, context);
    clearCalls();

    const files = collectChangedFiles(repo, context);
    const lines = collectChangedLines(repo, context);
    const safeDiff = collectSafeDiff(repo, context);
    const nonWhitespaceDiff = collectNonWhitespaceDiff(repo, context);
    assert.deepEqual(files, [
      { status: "A", file: "src/new.js" },
      { status: "M", file: "src/safe.js" },
    ]);
    assert.ok(lines.some((line) => line.file === "src/safe.js" && line.text.includes("safe-new-marker")));
    assert.ok(lines.some((line) => line.file === "src/new.js" && line.text.includes("untracked-safe-marker")));
    for (const output of [JSON.stringify(files), JSON.stringify(lines), safeDiff, nonWhitespaceDiff]) {
      for (const secret of [
        "tracked-secret-marker",
        "tracked-git-credential-marker",
        "untracked-secret-marker",
        "untracked-authinfo-marker",
        "untracked-authinfo-gpg-marker",
        "untracked-key-marker",
        "unsafe-path-marker",
        "generated-marker",
      ]) {
        assert.ok(!output.includes(secret), secret);
      }
    }
    assert.ok(safeDiff.includes("safe-new-marker"));
    assert.ok(safeDiff.includes("untracked-safe-marker"));

    const calls = readCalls().map(parseCall);
    const repositoryCalls = calls.filter((call) => call.cwd === fs.realpathSync(repo));
    const nameStatusCalls = repositoryCalls.filter((call) => call.args[0] === "diff" && call.args[1] === "--name-status");
    assert.ok(nameStatusCalls.length >= 4);
    for (const call of nameStatusCalls) {
      assert.deepEqual(call.args, [
        "diff",
        "--name-status",
        "-z",
        "--no-renames",
        comparison.baseOid,
        "--",
      ]);
    }
    const unmergedCalls = repositoryCalls.filter((call) => (
      call.args[0] === "ls-files" && call.args.includes("--unmerged")
    ));
    assert.ok(unmergedCalls.length >= 4);
    for (const call of unmergedCalls) {
      assert.deepEqual(call.args, ["ls-files", "--unmerged", "-z", "--"]);
    }
    const untrackedCalls = repositoryCalls.filter((call) => (
      call.args[0] === "ls-files" && call.args.includes("--others")
    ));
    assert.ok(untrackedCalls.length >= 4);
    for (const call of untrackedCalls) {
      assert.deepEqual(call.args, ["ls-files", "--others", "--exclude-standard", "-z", "--"]);
    }

    const contentCalls = repositoryCalls.filter((call) => call.args[0] === "diff" && call.args[1] !== "--name-status");
    assert.ok(contentCalls.length >= 3);
    for (const call of contentCalls) {
      assert.ok(call.args.includes("--no-ext-diff"));
      assert.ok(call.args.includes("--no-textconv"));
      assert.ok(call.args.includes("--src-prefix=a/"));
      assert.ok(call.args.includes("--dst-prefix=b/"));
      assert.ok(call.args.includes(comparison.baseOid));
      assert.ok(!call.args.includes("HEAD"));
      const separator = call.args.indexOf("--");
      assert.notEqual(separator, -1);
      assert.deepEqual(call.args.slice(separator + 1), [":(top,literal)src/safe.js"]);
      for (const secretPath of [
        ".ENV.production",
        ".GIT-CREDENTIALS",
        ".npmrc",
        ".authinfo",
        ".AUTHINFO.GPG",
        "private.PFX",
        "bad\\name.js",
        "dist/generated.js",
      ]) {
        assert.ok(!call.args.some((argument) => argument.includes(secretPath)), secretPath);
      }
    }
  });
});

test("an all-sensitive working tree performs no content diff", (t) => {
  const repo = createTestRepository({ ".env": "SECRET=old\n" });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    ".env": "SECRET=tracked-secret\n",
    ".SSH/id_rsa": "untracked-secret\n",
  });

  withGitWrapper("record", ({ clearCalls, readCalls }) => {
    const context = createComparisonContext(repo);
    clearCalls();
    assert.deepEqual(collectChangedFiles(repo, context), []);
    assert.deepEqual(collectChangedLines(repo, context), []);
    assert.equal(collectSafeDiff(repo, context), "");
    assert.equal(collectNonWhitespaceDiff(repo, context), "");

    const contentCalls = readCalls()
      .map(parseCall)
      .filter((call) => call.args[0] === "diff" && call.args[1] !== "--name-status");
    assert.deepEqual(contentCalls, []);
  });
});

test("unmerged paths are skipped without misattributing safe-file additions", (t) => {
  const repo = createTestRepository({
    "src/conflict.js": "export const conflict = 'base';\n",
    "src/safe.js": "export const safe = 'base';\n",
  });
  t.after(() => removeTestRepository(repo));
  git(repo, ["branch", "conflict-side"]);
  git(repo, ["checkout", "-q", "conflict-side"]);
  writeFiles(repo, { "src/conflict.js": "export const conflict = 'side-marker';\n" });
  git(repo, ["add", "--", "src/conflict.js"]);
  git(repo, ["commit", "-qm", "side change"]);
  git(repo, ["checkout", "-q", "main"]);
  writeFiles(repo, { "src/conflict.js": "export const conflict = 'main-marker';\n" });
  git(repo, ["add", "--", "src/conflict.js"]);
  git(repo, ["commit", "-qm", "main change"]);
  const merge = spawnSync(REAL_GIT, ["merge", "--no-edit", "conflict-side"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.notEqual(merge.status, 0);
  writeFiles(repo, { "src/safe.js": "export const safe = 'safe-working-marker';\n" });
  const rawStatus = spawnSync(REAL_GIT, [
    "diff", "--name-status", "-z", "--no-renames", "--",
  ], { cwd: repo });
  assert.equal(rawStatus.status, 0);
  assert.ok(
    rawStatus.stdout.includes(Buffer.from("U\0src/conflict.js\0")),
    rawStatus.stdout.toString("hex"),
  );

  withGitWrapper("record", ({ clearCalls, readCalls }) => {
    const context = createComparisonContext(repo);
    clearCalls();
    assert.deepEqual(collectChangedFiles(repo, context), [{ status: "M", file: "src/safe.js" }]);
    const lines = collectChangedLines(repo, context);
    const safeDiff = collectSafeDiff(repo, context);
    const nonWhitespaceDiff = collectNonWhitespaceDiff(repo, context);
    assert.ok(lines.some((line) => line.file === "src/safe.js" && line.text.includes("safe-working-marker")));
    for (const output of [JSON.stringify(lines), safeDiff, nonWhitespaceDiff]) {
      assert.ok(output.includes("safe-working-marker"));
      assert.ok(!output.includes("side-marker"));
      assert.ok(!output.includes("main-marker"));
      assert.ok(!output.includes("<<<<<<<"));
    }
    for (const call of readCalls().map(parseCall).filter((item) => (
      item.args[0] === "diff" && item.args[1] !== "--name-status"
    ))) {
      assert.deepEqual(call.args.slice(call.args.indexOf("--") + 1), [":(top,literal)src/safe.js"]);
    }
  });
});

test("content diffs batch at 128 literal pathspecs", (t) => {
  const initial = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [
    `src/file-${String(index).padStart(3, "0")}.js`,
    `export const value${index} = 'old';\n`,
  ]));
  const repo = createTestRepository(initial);
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, Object.fromEntries(Object.keys(initial).map((file, index) => [
    file,
    `export const value${index} = 'new';\n`,
  ])));

  withGitWrapper("record", ({ clearCalls, readCalls }) => {
    const context = createComparisonContext(repo);
    clearCalls();
    const diff = collectSafeDiff(repo, context);
    assert.ok(diff.includes("export const value0 = 'new'"));
    assert.ok(diff.includes("export const value128 = 'new'"));

    const contentCalls = readCalls()
      .map(parseCall)
      .filter((call) => call.args[0] === "diff" && call.args[1] !== "--name-status");
    assert.equal(contentCalls.length, 2);
    assert.deepEqual(contentCalls.map((call) => call.args.slice(call.args.indexOf("--") + 1).length), [128, 1]);
    for (const call of contentCalls) {
      for (const pathspec of call.args.slice(call.args.indexOf("--") + 1)) {
        assert.ok(pathspec.startsWith(":(top,literal)"), pathspec);
      }
    }
  });
});

test("explicit option-shaped base and head exclude secrets and working-tree changes", (t) => {
  const repo = createTestRepository({
    "src/value.js": "export const value = 'base';\n",
    ".ENV.Local": "SECRET=base\n",
    ".Git-Credentials": "https://base-credential\n",
  });
  t.after(() => removeTestRepository(repo));
  const base = git(repo, ["rev-parse", "HEAD"]);
  const head = commitFiles(repo, {
    "src/value.js": "export const value = 'committed-marker';\n",
    ".ENV.Local": "SECRET=committed-secret-marker\n",
    ".Git-Credentials": "https://committed-git-credential-marker\n",
  });
  git(repo, ["update-ref", "refs/heads/-base", base]);
  git(repo, ["update-ref", "refs/heads/--head", head]);
  writeFiles(repo, {
    "src/value.js": "export const value = 'working-tree-marker';\n",
    ".ENV.Local": "SECRET=working-tree-secret-marker\n",
    ".Git-Credentials": "https://working-tree-git-credential-marker\n",
    "src/working-only.js": "export const workingOnly = true;\n",
    ".AWS/credentials": "untracked-secret-marker\n",
  });

  withGitWrapper("record", ({ clearCalls, readCalls }) => {
    const context = createComparisonContext(repo, { base: "-base", head: "--head" });
    const resolutionCalls = readCalls().map(parseCall).filter((call) => (
      call.args.some((argument) => argument === "-base^{commit}" || argument === "--head^{commit}")
    ));
    assert.equal(resolutionCalls.length, 2);
    for (const call of resolutionCalls) {
      assert.deepEqual(call.args.slice(0, 4), ["rev-parse", "--verify", "--quiet", "--end-of-options"]);
    }

    const comparison = resolveComparison(repo, context);
    clearCalls();
    const files = collectChangedFiles(repo, context);
    const lines = collectChangedLines(repo, context);
    const safeDiff = collectSafeDiff(repo, context);
    const nonWhitespaceDiff = collectNonWhitespaceDiff(repo, context);
    assert.deepEqual(files, [{ status: "M", file: "src/value.js" }]);
    assert.ok(lines.some((line) => line.text.includes("committed-marker")));
    for (const output of [JSON.stringify(lines), safeDiff, nonWhitespaceDiff]) {
      assert.ok(output.includes("committed-marker"));
      for (const excluded of [
        "committed-secret-marker",
        "committed-git-credential-marker",
        "working-tree-marker",
        "working-tree-secret-marker",
        "working-tree-git-credential-marker",
        "untracked-secret-marker",
        "working-only.js",
      ]) {
        assert.ok(!output.includes(excluded), excluded);
      }
    }

    const calls = readCalls().map(parseCall);
    assert.ok(!calls.some((call) => call.args[0] === "ls-files"));
    const diffCalls = calls.filter((call) => call.args[0] === "diff");
    assert.ok(diffCalls.length >= 4);
    for (const call of diffCalls) {
      assert.ok(call.args.includes(comparison.baseOid));
      assert.ok(call.args.includes(comparison.headOid));
      assert.ok(!call.args.includes("-base"));
      assert.ok(!call.args.includes("--head"));
      if (call.args[1] !== "--name-status") {
        assert.ok(call.args.includes("--no-ext-diff"));
        assert.ok(call.args.includes("--no-textconv"));
        assert.deepEqual(call.args.slice(call.args.indexOf("--") + 1), [":(top,literal)src/value.js"]);
      }
    }
  });
});

test("content diff failures redact stdout while preserving stderr diagnostics", (t) => {
  const repo = createTestRepository({ "src/value.js": "export const value = 'old';\n" });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, { "src/value.js": "export const value = 'new';\n" });
  const context = createComparisonContext(repo);

  withGitWrapper("content-failure-stdout", () => {
    assert.throws(
      () => collectSafeDiff(repo, context),
      (error) => error instanceof Error && !error.message.includes("STDOUT-ONLY-SECRET-MARKER"),
    );
  });
  withGitWrapper("content-failure-stderr", () => {
    assert.throws(
      () => collectSafeDiff(repo, context),
      (error) => error instanceof Error
        && error.message.includes("content diff diagnostic")
        && !error.message.includes("STDOUT-SECRET-MARKER"),
    );
  });
});
