import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTestRepository, removeTestRepository } from "./test-repository.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "plugins/frontend-engineering-standard/scripts/marketplace-cli.mjs");
const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

function runCli(args, script = CLI) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function runDoctorWithGitWrapper(mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-doctor-git-"));
  const wrapper = path.join(directory, "git");
  const log = path.join(directory, "calls.log");
  fs.writeFileSync(wrapper, `#!/bin/sh
{
  for argument in "$@"; do printf '%s\\t' "$argument"; done
  printf '\\n'
} >> "$AI_MARKETPLACE_DOCTOR_GIT_LOG"
if [ "$AI_MARKETPLACE_DOCTOR_GIT_MODE" = "unsupported" ] && [ "$1" = "rev-parse" ]; then
  for argument in "$@"; do
    if [ "$argument" = "--end-of-options" ]; then
      printf '%s\\n' 'unknown option: --end-of-options' >&2
      exit 129
    fi
  done
fi
exec "$AI_MARKETPLACE_REAL_GIT" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(log, "");
  try {
    const result = spawnSync(process.execPath, [CLI, "doctor"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
        AI_MARKETPLACE_DOCTOR_GIT_LOG: log,
        AI_MARKETPLACE_DOCTOR_GIT_MODE: mode,
        AI_MARKETPLACE_REAL_GIT: REAL_GIT,
      },
    });
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    return { result, calls };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createPluginFixture(t, {
  skillsPath = "./capabilities/",
  skills = ["custom-a", "custom-b"],
  ui = ["custom-a", "custom-b"],
} = {}) {
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-cli-plugin-"));
  t.after(() => fs.rmSync(pluginRoot, { recursive: true, force: true }));
  const manifest = { name: "fixture-plugin" };
  if (skillsPath !== undefined) manifest.skills = skillsPath;
  writeJson(path.join(pluginRoot, ".codex-plugin/plugin.json"), manifest);
  if (skillsPath !== undefined) {
    const skillsRoot = path.resolve(pluginRoot, skillsPath);
    fs.mkdirSync(skillsRoot, { recursive: true });
    for (const skill of skills) {
      writeText(path.join(skillsRoot, skill, "SKILL.md"), `---\nname: ${skill}\n---\n`);
      if (ui.includes(skill)) {
        writeText(
          path.join(skillsRoot, skill, "agents/openai.yaml"),
          `interface:\n  default_prompt: "Use $${skill}."\n`,
        );
      }
    }
  }
  return pluginRoot;
}

function restoreSwappedFile(target, backup) {
  try {
    fs.unlinkSync(target);
  } catch {
    // The swap may have been rejected before the replacement was installed.
  }
  try {
    fs.renameSync(backup, target);
  } catch {
    // The original path is already in place when no swap occurred.
  }
}

function runCopiedDoctorWithAtomicUiSwap(t) {
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-cli-doctor-swap-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-cli-doctor-outside-"));
  t.after(() => fs.rmSync(pluginRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));

  const scriptsRoot = path.join(ROOT, "plugins/frontend-engineering-standard/scripts");
  fs.cpSync(scriptsRoot, path.join(pluginRoot, "scripts"), { recursive: true });
  writeJson(path.join(pluginRoot, ".codex-plugin/plugin.json"), {
    name: "fixture-plugin",
    skills: "./capabilities/",
  });
  writeText(path.join(pluginRoot, "capabilities/custom-a/SKILL.md"), "---\nname: custom-a\n---\n");

  const uiFile = path.join(pluginRoot, "capabilities/custom-a/agents/openai.yaml");
  const uiBackup = `${uiFile}.original`;
  const marker = "EXTERNAL_UI_MARKER";
  const outsideUi = path.join(outsideRoot, "openai.yaml");
  const traceFile = path.join(pluginRoot, "swap-trace.log");
  const preloadFile = path.join(pluginRoot, "atomic-ui-swap.mjs");
  writeText(uiFile, 'interface:\n  default_prompt: "Safe local prompt."\n');
  writeText(outsideUi, `interface:\n  default_prompt: "Use $custom-a. ${marker}"\n`);
  const matchedUiFile = fs.realpathSync(uiFile);
  writeText(preloadFile, `
import fs from "node:fs";
import path from "node:path";

const target = ${JSON.stringify(uiFile)};
const matchedTarget = ${JSON.stringify(matchedUiFile)};
const backup = ${JSON.stringify(uiBackup)};
const outside = ${JSON.stringify(outsideUi)};
const trace = ${JSON.stringify(traceFile)};
const marker = ${JSON.stringify(marker)};
const originalRealpathSync = fs.realpathSync;
const originalReadFileSync = fs.readFileSync;
let swapped = false;

fs.realpathSync = (candidate, ...args) => {
  const real = originalRealpathSync.call(fs, candidate, ...args);
  if (!swapped && typeof candidate === "string" && path.resolve(candidate) === path.resolve(matchedTarget)) {
    fs.renameSync(target, backup);
    fs.symlinkSync(outside, target, "file");
    fs.appendFileSync(trace, "swapped\\n");
    swapped = true;
  }
  return real;
};

fs.readFileSync = (file, ...args) => {
  const content = originalReadFileSync.call(fs, file, ...args);
  if (String(content).includes(marker)) fs.appendFileSync(trace, "marker-read\\n");
  return content;
};

process.on("exit", () => {
  fs.realpathSync = originalRealpathSync;
  fs.readFileSync = originalReadFileSync;
  if (!swapped) return;
  try { fs.unlinkSync(target); } catch {}
  try { fs.renameSync(backup, target); } catch {}
});
`);

  const cli = path.join(pluginRoot, "scripts/marketplace-cli.mjs");
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preloadFile).href, cli, "doctor"], {
    encoding: "utf8",
  });
  const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8").trim().split("\n") : [];
  return { result, trace };
}

const INVALID_CASES = [
  {
    name: "unknown option",
    args: ["rules", "--unknown", "value"],
    error: /Unknown option: --unknown/,
  },
  {
    name: "positional argument",
    args: ["rules", "positional"],
    error: /Unexpected argument: positional/,
  },
  {
    name: "single-dash argument",
    args: ["rules", "-r", "value"],
    error: /Unexpected argument: -r/,
  },
  {
    name: "duplicate option",
    args: ["rules", "--repo", "first", "--repo", "second"],
    error: /Duplicate option: --repo/,
  },
  {
    name: "empty inline value",
    args: ["rules", "--repo="],
    error: /Empty value for --repo/,
  },
  {
    name: "missing final value",
    args: ["rules", "--repo"],
    error: /Missing value for --repo/,
  },
  {
    name: "next option is not consumed as a value",
    args: ["rules", "--repo", "--format", "json"],
    error: /Missing value for --repo/,
  },
  {
    name: "rules command rejects requirement",
    args: ["rules", "--requirement=value"],
    error: /Unknown option: --requirement/,
  },
];

for (const fixture of INVALID_CASES) {
  test(`CLI rejects ${fixture.name}`, () => {
    const result = runCli(fixture.args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, fixture.error);
  });
}

test("CLI preserves every equals sign in an inline requirement beginning with --", (t) => {
  const repo = createTestRepository({ "package.json": "{\"private\":true}\n" });
  t.after(() => removeTestRepository(repo));

  const result = runCli([
    "impact",
    `--repo=${repo}`,
    "--requirement=--draft=a=b",
    "--format=json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).requirement, "--draft=a=b");
});

test("CLI keeps valid spaced options and success exit code compatible", (t) => {
  const repo = createTestRepository({ "package.json": "{\"private\":true}\n" });
  t.after(() => removeTestRepository(repo));

  const result = runCli(["rules", "--repo", repo, "--format", "json"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).capability, "project-rules");
});

test("CLI executes through a symbolic link", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-cli-link-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const linkedCli = path.join(directory, "marketplace-cli.mjs");
  fs.symlinkSync(CLI, linkedCli, "file");

  const result = runCli(["--help"], linkedCli);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});

test("CLI module import is side-effect free and parseOptions returns a frozen object", async () => {
  const output = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  console.log = (...args) => output.push(args.join(" "));
  console.error = (...args) => output.push(args.join(" "));
  try {
    const module = await import(pathToFileURL(CLI).href);
    const options = module.parseOptions("impact", [
      "--repo=/tmp/example",
      "--requirement=--draft=a=b",
    ]);
    assert.deepEqual(options, { repo: "/tmp/example", requirement: "--draft=a=b" });
    assert.equal(Object.isFrozen(options), true);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(output, []);
  assert.equal(process.exitCode, originalExitCode);
});

test("discoverManifestSkills follows the manifest directory without fixed skill names", async (t) => {
  const pluginRoot = createPluginFixture(t, { ui: ["custom-a"] });
  const module = await import(pathToFileURL(CLI).href);

  assert.equal(typeof module.discoverManifestSkills, "function");
  const skills = module.discoverManifestSkills(pluginRoot);

  assert.deepEqual(skills.map((skill) => skill.name), ["custom-a", "custom-b"]);
  assert.equal(skills[0].uiFile.endsWith("capabilities/custom-a/agents/openai.yaml"), true);
  assert.equal(skills[1].uiFile, null);
});

test("discoverManifestSkills rejects missing and unsafe manifest declarations", async (t) => {
  const module = await import(pathToFileURL(CLI).href);

  await t.test("missing skills declaration", (t) => {
    const pluginRoot = createPluginFixture(t);
    writeJson(path.join(pluginRoot, ".codex-plugin/plugin.json"), { name: "fixture-plugin" });
    assert.throws(
      () => module.discoverManifestSkills(pluginRoot),
      /Plugin manifest must declare a skills directory/,
    );
  });

  await t.test("parent path", (t) => {
    const pluginRoot = createPluginFixture(t);
    writeJson(path.join(pluginRoot, ".codex-plugin/plugin.json"), {
      name: "fixture-plugin",
      skills: "../outside",
    });
    assert.throws(
      () => module.discoverManifestSkills(pluginRoot),
      /Plugin skills path must stay inside the plugin/,
    );
  });

  await t.test("manifest link", (t) => {
    const pluginRoot = createPluginFixture(t);
    const manifest = path.join(pluginRoot, ".codex-plugin/plugin.json");
    const target = path.join(pluginRoot, "manifest-target.json");
    fs.renameSync(manifest, target);
    fs.symlinkSync(target, manifest, "file");
    assert.throws(
      () => module.discoverManifestSkills(pluginRoot),
      /Plugin manifest contains a symbolic link/,
    );
  });

  await t.test("skills directory link", (t) => {
    const pluginRoot = createPluginFixture(t, { skills: [] });
    const skillsRoot = path.join(pluginRoot, "capabilities");
    const target = path.join(pluginRoot, "capabilities-target");
    fs.renameSync(skillsRoot, target);
    fs.symlinkSync(target, skillsRoot, "dir");
    assert.throws(
      () => module.discoverManifestSkills(pluginRoot),
      /Plugin skills directory contains a symbolic link/,
    );
  });
});

test("discoverManifestSkills rejects symbolic links inside a skills bundle", async (t) => {
  const module = await import(pathToFileURL(CLI).href);

  await t.test("skill directory", (t) => {
    const pluginRoot = createPluginFixture(t, { skills: [] });
    const target = path.join(pluginRoot, "actual-skill");
    writeText(path.join(target, "SKILL.md"), "---\nname: linked\n---\n");
    fs.symlinkSync(target, path.join(pluginRoot, "capabilities/linked"), "dir");
    assert.throws(
      () => module.discoverManifestSkills(pluginRoot),
      /Skill linked directory contains a symbolic link/,
    );
  });

  await t.test("SKILL.md", (t) => {
    const pluginRoot = createPluginFixture(t, { skills: ["custom-a"] });
    const skillFile = path.join(pluginRoot, "capabilities/custom-a/SKILL.md");
    const target = path.join(pluginRoot, "capabilities/custom-a/ACTUAL.md");
    fs.renameSync(skillFile, target);
    fs.symlinkSync(target, skillFile, "file");
    assert.throws(
      () => module.discoverManifestSkills(pluginRoot),
      /Skill custom-a SKILL\.md contains a symbolic link/,
    );
  });

  await t.test("openai.yaml", (t) => {
    const pluginRoot = createPluginFixture(t, { skills: ["custom-a"] });
    const uiFile = path.join(pluginRoot, "capabilities/custom-a/agents/openai.yaml");
    const target = path.join(pluginRoot, "capabilities/custom-a/agents/ACTUAL.yaml");
    fs.renameSync(uiFile, target);
    fs.symlinkSync(target, uiFile, "file");
    assert.throws(
      () => module.discoverManifestSkills(pluginRoot),
      /Skill custom-a UI metadata contains a symbolic link/,
    );
  });
});

test("discoverManifestSkills rejects a manifest swapped after path validation without reading it", async (t) => {
  const pluginRoot = createPluginFixture(t, { skills: ["safe"], ui: ["safe"] });
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-cli-manifest-outside-"));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const manifest = path.join(pluginRoot, ".codex-plugin/plugin.json");
  const backup = `${manifest}.original`;
  const outsideManifest = path.join(outsideRoot, "plugin.json");
  const marker = "EXTERNAL_MANIFEST_MARKER";
  writeJson(outsideManifest, {
    name: "fixture-plugin",
    skills: "./attacker-capabilities/",
    marker,
  });
  writeText(
    path.join(pluginRoot, "attacker-capabilities/external-marker/SKILL.md"),
    "---\nname: external-marker\n---\n",
  );

  const module = await import(pathToFileURL(CLI).href);
  const originalRealpathSync = fs.realpathSync;
  const originalReadFileSync = fs.readFileSync;
  const matchedManifest = originalRealpathSync.call(fs, manifest);
  let swapped = false;
  let markerRead = false;
  let thrown;
  try {
    fs.realpathSync = (candidate, ...args) => {
      const real = originalRealpathSync.call(fs, candidate, ...args);
      if (!swapped && typeof candidate === "string" && path.resolve(candidate) === path.resolve(matchedManifest)) {
        fs.renameSync(manifest, backup);
        fs.renameSync(outsideManifest, manifest);
        swapped = true;
      }
      return real;
    };
    fs.readFileSync = (file, ...args) => {
      const content = originalReadFileSync.call(fs, file, ...args);
      if (String(content).includes(marker)) markerRead = true;
      return content;
    };
    try {
      module.discoverManifestSkills(pluginRoot);
    } catch (error) {
      thrown = error;
    }
  } finally {
    fs.realpathSync = originalRealpathSync;
    fs.readFileSync = originalReadFileSync;
    if (swapped) restoreSwappedFile(manifest, backup);
  }

  assert.equal(swapped, true);
  assert.equal(markerRead, false, "external manifest marker must not be read");
  assert.match(thrown?.message ?? "", /symbolic link|changed while being opened/i);
});

test("doctor rejects UI metadata swapped after path validation without reading it", (t) => {
  const { result, trace } = runCopiedDoctorWithAtomicUiSwap(t);

  assert.ok(trace.includes("swapped"), trace.join(", "));
  assert.ok(!trace.includes("marker-read"), trace.join(", "));
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /symbolic link|changed while being opened/i);
});

test("doctor passes for the real plugin using manifest-discovered skills", () => {
  const result = runCli(["doctor"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Doctor passed/);
});

test("doctor probes rev-parse --end-of-options in an isolated Git repository", () => {
  const { result, calls } = runDoctorWithGitWrapper("supported");

  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls.some((call) => call.includes(
    "rev-parse\t--verify\t--quiet\t--end-of-options\trefs/heads/__git_evidence_missing__^{commit}",
  )));
});

test("doctor fails clearly when guarded revision parsing is unsupported", () => {
  const { result, calls } = runDoctorWithGitWrapper("unsupported");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Git does not support rev-parse --end-of-options/);
  assert.ok(calls.some((call) => call.includes("rev-parse\t") && call.includes("--end-of-options\t")));
});
