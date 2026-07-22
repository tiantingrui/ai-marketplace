import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as validatorModule from "../scripts/validate-marketplace.mjs";
import { buildTrustedReadOpenFlags } from "../scripts/lib/fs-open-flags.mjs";
import {
  validateFrontendEngineeringStandard,
  validateMarketplace,
  validateMarketplaceTopology,
  validatePluginBundle,
  validateRepositoryRelease,
} from "../scripts/validate-marketplace.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATOR = path.join(ROOT, "scripts/validate-marketplace.mjs");
const CONTRACT_FILES = [
  "project-config.schema.json",
  "rule-report.schema.json",
  "impact-report.schema.json",
  "review-context.schema.json",
  "review-output.schema.json",
  "rule-registry.schema.json",
];
const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_ID_BASE = "https://github.com/tiantingrui/ai-marketplace/plugins/frontend-engineering-standard/schemas/";
const STANDARD_RUNTIME_FILES = [
  "scripts/marketplace-cli.mjs",
  "scripts/lib/git-evidence.mjs",
  "scripts/lib/project-config.mjs",
  "scripts/lib/rule-checker.mjs",
  "scripts/lib/impact-analyzer.mjs",
  "scripts/lib/review-context.mjs",
];
const PUBLIC_RELEASE_FILES = [
  ".github/CODEOWNERS",
  ".github/pull_request_template.md",
  ".github/workflows/validate.yml",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "SECURITY.md",
  "docs/architecture.md",
  "docs/configuration.md",
  "docs/getting-started.md",
  "docs/releasing.md",
  "examples/project-config.example.json",
];
function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-validation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runValidator(args, script = VALIDATOR) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function withControlledFileSwap({ file, externalFile, marker, trigger }, callback) {
  const originalLstatSync = fs.lstatSync;
  const originalReadFileSync = fs.readFileSync;
  const originalRealpathSync = fs.realpathSync;
  const absolute = originalRealpathSync.call(fs, path.resolve(file));
  const backup = `${absolute}.before-swap`;
  let matchingLstats = 0;
  let markerRead = false;
  let swapped = false;

  const matches = (candidate) => typeof candidate === "string" && path.resolve(candidate) === absolute;
  const swap = () => {
    if (swapped) return;
    fs.renameSync(absolute, backup);
    fs.symlinkSync(externalFile, absolute, "file");
    swapped = true;
  };

  fs.realpathSync = function controlledRealpathSync(candidate, ...args) {
    const real = originalRealpathSync.call(fs, candidate, ...args);
    if (trigger === "after-realpath" && matches(candidate)) swap();
    return real;
  };
  fs.lstatSync = function controlledLstatSync(candidate, ...args) {
    const metadata = originalLstatSync.call(fs, candidate, ...args);
    if (matches(candidate)) {
      matchingLstats += 1;
      if (trigger === "after-second-lstat" && matchingLstats === 2) swap();
    }
    return metadata;
  };
  fs.readFileSync = function observedReadFileSync(candidate, ...args) {
    const content = originalReadFileSync.call(fs, candidate, ...args);
    if (String(content).includes(marker)) markerRead = true;
    return content;
  };

  try {
    const value = callback();
    return { value, markerRead, swapped };
  } finally {
    fs.lstatSync = originalLstatSync;
    fs.readFileSync = originalReadFileSync;
    fs.realpathSync = originalRealpathSync;
    if (swapped) {
      fs.unlinkSync(absolute);
      fs.renameSync(backup, absolute);
    }
  }
}

test("trusted read flags fall back when O_NOFOLLOW is unavailable", () => {
  assert.equal(buildTrustedReadOpenFlags({ O_RDONLY: 8 }), 8);
  assert.equal(buildTrustedReadOpenFlags({ O_RDONLY: 8, O_NOFOLLOW: "256" }), 8);
  assert.equal(buildTrustedReadOpenFlags({ O_RDONLY: 8, O_NOFOLLOW: 256 }), 264);
});

test("validator module exposes exactly the five approved validation functions", () => {
  assert.deepEqual(Object.keys(validatorModule).sort(), [
    "validateFrontendEngineeringStandard",
    "validateMarketplace",
    "validateMarketplaceTopology",
    "validatePluginBundle",
    "validateRepositoryRelease",
  ]);
});

function marketplaceEntry(name, sourcePath = `./plugins/${name}`) {
  return {
    name,
    source: { source: "local", path: sourcePath },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools",
  };
}

function writeMarketplace(root, entries) {
  writeJson(path.join(root, ".agents/plugins/marketplace.json"), {
    name: "fixture-marketplace",
    interface: { displayName: "Fixture Marketplace" },
    plugins: entries,
  });
}

function pluginManifest(name, skillsPath) {
  const manifest = {
    name,
    version: "1.0.0",
    description: `A complete fixture plugin description for ${name}.`,
    license: "Apache-2.0",
    author: { name: "Fixture Author" },
    homepage: "https://example.invalid/plugin",
    repository: "https://example.invalid/repository",
    interface: {
      displayName: name,
      shortDescription: "Fixture plugin",
      longDescription: "A fixture plugin used to verify local Marketplace discovery.",
      developerName: "Fixture Author",
      category: "Developer Tools",
      defaultPrompt: [],
    },
  };
  if (skillsPath !== undefined) manifest.skills = skillsPath;
  return manifest;
}

function writePlugin(root, name, {
  sourcePath = `./plugins/${name}`,
  manifestName = name,
  skills,
  ui = true,
} = {}) {
  const pluginRoot = path.resolve(root, sourcePath.slice(2));
  const skillsPath = skills === undefined ? undefined : "./skills/";
  writeJson(path.join(pluginRoot, ".codex-plugin/plugin.json"), pluginManifest(manifestName, skillsPath));
  if (skills !== undefined) {
    fs.mkdirSync(path.join(pluginRoot, "skills"), { recursive: true });
    for (const skill of skills) {
      writeText(path.join(pluginRoot, "skills", skill, "SKILL.md"), [
        "---",
        `name: ${skill}`,
        "description: This fixture description is deliberately longer than forty characters.",
        "---",
        "",
        `# ${skill}`,
        "",
      ].join("\n"));
      if (ui) {
        writeText(
          path.join(pluginRoot, "skills", skill, "agents/openai.yaml"),
          `interface:\n  default_prompt: "Use $${skill} for this fixture."\n`,
        );
      }
    }
  }
  return pluginRoot;
}

function validateBundles(root) {
  const topology = validateMarketplaceTopology(root);
  const bundles = topology.plugins.map((plugin) => validatePluginBundle(topology, plugin));
  return {
    topology,
    bundles,
    errors: [...topology.errors, ...bundles.flatMap((bundle) => bundle.errors)],
  };
}

function createSingleBundleFixture(t, name = "alpha", options = {}) {
  const root = createFixture(t);
  writeMarketplace(root, [marketplaceEntry(name)]);
  const pluginRoot = writePlugin(root, name, options);
  const topology = validateMarketplaceTopology(root);
  assert.deepEqual(topology.errors, []);
  assert.equal(topology.plugins.length, 1);
  return { root, pluginRoot, topology, plugin: topology.plugins[0] };
}

function writeRegistry(pluginRoot, tests = ["tests/standard-gate.test.mjs"]) {
  writeJson(path.join(pluginRoot, "rules/registry.json"), {
    schemaVersion: "1.0",
    families: [{ familyId: "fixture-family", tests }],
  });
}

function createStandardGateFixture(t, { skills = ["audit"], ui = true } = {}) {
  const root = createFixture(t);
  writeMarketplace(root, [marketplaceEntry("frontend-engineering-standard")]);
  const pluginRoot = writePlugin(root, "frontend-engineering-standard", { skills, ui });
  for (const file of STANDARD_RUNTIME_FILES) {
    writeText(path.join(pluginRoot, file), `export const fixture = ${JSON.stringify(file)};\n`);
  }
  for (const file of CONTRACT_FILES) {
    writeJson(path.join(pluginRoot, "schemas", file), {
      $schema: SCHEMA_DIALECT,
      $id: `${SCHEMA_ID_BASE}${file}`,
      type: "object",
    });
  }
  writeText(path.join(root, "tests/standard-gate.test.mjs"), "export const fixture = true;\n");
  writeRegistry(pluginRoot);

  const topology = validateMarketplaceTopology(root);
  const bundles = topology.plugins.map((plugin) => validatePluginBundle(topology, plugin));
  assert.deepEqual([...topology.errors, ...bundles.flatMap((bundle) => bundle.errors)], []);
  return { root, pluginRoot, topology, bundles };
}

function createRepositoryReleaseFixture(t, version) {
  const fixture = createStandardGateFixture(t);
  writeJson(path.join(fixture.root, ".agents/plugins/marketplace.json"), {
    name: "ai-marketplace",
    interface: { displayName: "AI Marketplace" },
    plugins: [marketplaceEntry("frontend-engineering-standard")],
  });
  const manifestPath = path.join(fixture.pluginRoot, ".codex-plugin/plugin.json");
  writeJson(manifestPath, { ...JSON.parse(fs.readFileSync(manifestPath, "utf8")), version });
  writeJson(path.join(fixture.root, "package.json"), { version, license: "Apache-2.0" });

  for (const file of PUBLIC_RELEASE_FILES) {
    writeText(path.join(fixture.root, file), `# ${file}\n`);
  }
  writeText(path.join(fixture.root, "LICENSE"), "Apache License\nVersion 2.0, January 2004\n");
  writeText(path.join(fixture.root, "README.md"), [
    "# AI Marketplace",
    "",
    `codex plugin install frontend-engineering-standard@ai-marketplace --ref v${version}`,
    "",
    "https://github.com/tiantingrui/ai-marketplace",
    "",
    "Apache License 2.0",
    "",
  ].join("\n"));

  const topology = validateMarketplaceTopology(fixture.root);
  const bundles = topology.plugins.map((plugin) => validatePluginBundle(topology, plugin));
  assert.deepEqual([...topology.errors, ...bundles.flatMap((bundle) => bundle.errors)], []);
  return { ...fixture, topology, bundles };
}

test("marketplace topology and bundles discover two local plugins with optional skills", (t) => {
  const root = createFixture(t);
  writeMarketplace(root, [marketplaceEntry("alpha"), marketplaceEntry("beta")]);
  writePlugin(root, "alpha", { skills: ["audit", "review"] });
  writePlugin(root, "beta");

  const { topology, bundles, errors } = validateBundles(root);

  assert.deepEqual(errors, []);
  assert.equal(topology.rootReal, fs.realpathSync(root));
  assert.deepEqual(topology.plugins.map((plugin) => plugin.entry.name), ["alpha", "beta"]);
  assert.deepEqual(bundles.map((bundle) => bundle.skills.map((skill) => skill.name)), [
    ["audit", "review"],
    [],
  ]);
});

test("generic bundle allows an empty skills directory and missing UI metadata", (t) => {
  const root = createFixture(t);
  writeMarketplace(root, [marketplaceEntry("empty"), marketplaceEntry("headless")]);
  writePlugin(root, "empty", { skills: [] });
  writePlugin(root, "headless", { skills: ["inspect"], ui: false });

  const { bundles, errors } = validateBundles(root);

  assert.deepEqual(errors, []);
  assert.equal(bundles[0].skills.length, 0);
  assert.equal(bundles[1].skills[0].uiFile, null);
});

test("topology rejects an empty plugin list without throwing", (t) => {
  const root = createFixture(t);
  writeMarketplace(root, []);

  const topology = validateMarketplaceTopology(root);

  assert.match(topology.errors.join("\n"), /plugins must be a non-empty array/);
  assert.deepEqual(topology.plugins, []);
});

test("topology rejects duplicate names and duplicate normalized real roots", (t) => {
  const root = createFixture(t);
  writePlugin(root, "alpha");
  writeMarketplace(root, [
    marketplaceEntry("alpha"),
    marketplaceEntry("alpha"),
    marketplaceEntry("alias", "./plugins/./alpha"),
  ]);

  const topology = validateMarketplaceTopology(root);

  assert.match(topology.errors.join("\n"), /duplicate plugin name: alpha/);
  assert.match(topology.errors.join("\n"), /duplicate plugin source real path/);
  assert.equal(topology.plugins.length, 1);
});

test("topology rejects lexical escape and unsupported source entries", (t) => {
  const root = createFixture(t);
  writeMarketplace(root, [
    marketplaceEntry("escape", "./plugins/../escape"),
    {
      ...marketplaceEntry("remote"),
      source: { source: "git", url: "https://example.invalid/repository.git" },
    },
  ]);

  const topology = validateMarketplaceTopology(root);

  assert.match(topology.errors.join("\n"), /escape: source.path must not contain \.\./);
  assert.match(topology.errors.join("\n"), /remote: source must be a local object/);
  assert.deepEqual(topology.plugins, []);
});

test("topology rejects a symbolic-link root", (t) => {
  const root = createFixture(t);
  const alias = `${root}-alias`;
  fs.symlinkSync(root, alias, "dir");
  t.after(() => fs.rmSync(alias, { force: true }));

  const topology = validateMarketplaceTopology(alias);

  assert.match(topology.errors.join("\n"), /Marketplace root must not be a symbolic link/);
  assert.deepEqual(topology.plugins, []);
});

test("topology rejects final and intermediate source symbolic links", (t) => {
  const root = createFixture(t);
  const target = writePlugin(root, "target");
  fs.symlinkSync(target, path.join(root, "plugins/final-link"), "dir");
  fs.symlinkSync(path.join(root, "plugins"), path.join(root, "plugin-link"), "dir");
  writeMarketplace(root, [
    marketplaceEntry("final-link", "./plugins/final-link"),
    marketplaceEntry("target", "./plugin-link/target"),
  ]);

  const topology = validateMarketplaceTopology(root);

  assert.match(topology.errors.join("\n"), /final-link: source.path contains a symbolic link/);
  assert.match(topology.errors.join("\n"), /target: source.path contains a symbolic link/);
  assert.deepEqual(topology.plugins, []);
});

test("topology rejects absolute and backslash local source paths without descriptors", async (t) => {
  const cases = [
    ["absolute", "/tmp/outside-plugin", /source\.path must start with \./],
    ["backslash", ".\\plugins\\unsafe", /source\.path must use POSIX separators/],
  ];
  for (const [name, sourcePath, expected] of cases) {
    await t.test(name, (t) => {
      const root = createFixture(t);
      writeMarketplace(root, [marketplaceEntry(name, sourcePath)]);
      let topology;
      assert.doesNotThrow(() => {
        topology = validateMarketplaceTopology(root);
      });
      assert.match(topology.errors.join("\n"), expected);
      assert.deepEqual(topology.plugins, []);
    });
  }
});

test("topology rejects final and intermediate Marketplace manifest symbolic links", async (t) => {
  await t.test("manifest file", (t) => {
    const root = createFixture(t);
    writeMarketplace(root, [marketplaceEntry("alpha")]);
    writePlugin(root, "alpha");
    const manifest = path.join(root, ".agents/plugins/marketplace.json");
    const target = path.join(root, ".agents/plugins/marketplace-target.json");
    fs.renameSync(manifest, target);
    fs.symlinkSync(target, manifest, "file");

    let topology;
    assert.doesNotThrow(() => {
      topology = validateMarketplaceTopology(root);
    });
    assert.match(topology.errors.join("\n"), /marketplace\.json contains a symbolic link/);
    assert.deepEqual(topology.plugins, []);
  });

  await t.test("manifest parent directory", (t) => {
    const root = createFixture(t);
    writeMarketplace(root, [marketplaceEntry("alpha")]);
    writePlugin(root, "alpha");
    const directory = path.join(root, ".agents/plugins");
    const target = path.join(root, ".agents/plugins-target");
    fs.renameSync(directory, target);
    fs.symlinkSync(target, directory, "dir");

    let topology;
    assert.doesNotThrow(() => {
      topology = validateMarketplaceTopology(root);
    });
    assert.match(topology.errors.join("\n"), /marketplace\.json contains a symbolic link/);
    assert.deepEqual(topology.plugins, []);
  });
});

test("topology rejects a missing root and non-array plugins without throwing", async (t) => {
  await t.test("missing root", (t) => {
    const existing = createFixture(t);
    const missing = path.join(existing, "does-not-exist");
    let topology;
    assert.doesNotThrow(() => {
      topology = validateMarketplaceTopology(missing);
    });
    assert.match(topology.errors.join("\n"), /Marketplace root cannot be accessed/);
    assert.deepEqual(topology.plugins, []);

    let aggregate;
    assert.doesNotThrow(() => {
      aggregate = validateMarketplace(missing);
    });
    assert.match(aggregate.errors.join("\n"), /Marketplace root cannot be accessed/);
  });

  await t.test("plugins object", (t) => {
    const root = createFixture(t);
    writeJson(path.join(root, ".agents/plugins/marketplace.json"), {
      name: "fixture-marketplace",
      interface: { displayName: "Fixture Marketplace" },
      plugins: {},
    });
    let topology;
    assert.doesNotThrow(() => {
      topology = validateMarketplaceTopology(root);
    });
    assert.match(topology.errors.join("\n"), /plugins must be a non-empty array/);
    assert.deepEqual(topology.plugins, []);

    let aggregate;
    assert.doesNotThrow(() => {
      aggregate = validateMarketplace(root);
    });
    assert.match(aggregate.errors.join("\n"), /plugins must be a non-empty array/);
  });
});

test("bundle rejects final and intermediate manifest symbolic links", async (t) => {
  await t.test("final manifest link", (t) => {
    const { pluginRoot, topology, plugin } = createSingleBundleFixture(t);
    const manifest = path.join(pluginRoot, ".codex-plugin/plugin.json");
    const target = path.join(pluginRoot, "manifest-target.json");
    fs.renameSync(manifest, target);
    fs.symlinkSync(target, manifest, "file");

    const bundle = validatePluginBundle(topology, plugin);

    assert.match(bundle.errors.join("\n"), /plugin\.json contains a symbolic link/);
  });

  await t.test("intermediate manifest link", (t) => {
    const { pluginRoot, topology, plugin } = createSingleBundleFixture(t);
    const metadata = path.join(pluginRoot, ".codex-plugin");
    const target = path.join(pluginRoot, "metadata-target");
    fs.renameSync(metadata, target);
    fs.symlinkSync(target, metadata, "dir");

    const bundle = validatePluginBundle(topology, plugin);

    assert.match(bundle.errors.join("\n"), /plugin\.json contains a symbolic link/);
  });
});

test("bundle rejects symbolic links for skill directories, SKILL files, and UI files", async (t) => {
  await t.test("skill directory link", (t) => {
    const { pluginRoot, topology, plugin } = createSingleBundleFixture(t, "alpha", { skills: [] });
    const target = path.join(pluginRoot, "actual-skill");
    writeText(path.join(target, "SKILL.md"), "---\nname: linked\ndescription: This description is deliberately longer than forty characters.\n---\n");
    fs.symlinkSync(target, path.join(pluginRoot, "skills/linked"), "dir");

    const bundle = validatePluginBundle(topology, plugin);

    assert.match(bundle.errors.join("\n"), /skill linked directory contains a symbolic link/);
  });

  await t.test("SKILL.md link", (t) => {
    const { pluginRoot, topology, plugin } = createSingleBundleFixture(t, "alpha", { skills: ["audit"] });
    const skillFile = path.join(pluginRoot, "skills/audit/SKILL.md");
    const target = path.join(pluginRoot, "skills/audit/ACTUAL.md");
    fs.renameSync(skillFile, target);
    fs.symlinkSync(target, skillFile, "file");

    const bundle = validatePluginBundle(topology, plugin);

    assert.match(bundle.errors.join("\n"), /SKILL\.md contains a symbolic link/);
  });

  await t.test("openai.yaml link", (t) => {
    const { pluginRoot, topology, plugin } = createSingleBundleFixture(t, "alpha", { skills: ["audit"] });
    const uiFile = path.join(pluginRoot, "skills/audit/agents/openai.yaml");
    const target = path.join(pluginRoot, "skills/audit/agents/ACTUAL.yaml");
    fs.renameSync(uiFile, target);
    fs.symlinkSync(target, uiFile, "file");

    const bundle = validatePluginBundle(topology, plugin);

    assert.match(bundle.errors.join("\n"), /openai\.yaml contains a symbolic link/);
  });
});

test("bundle rejects a symbolic-link UI directory even when optional metadata is absent", (t) => {
  const { pluginRoot, topology, plugin } = createSingleBundleFixture(t, "alpha", {
    skills: ["audit"],
    ui: false,
  });
  const target = path.join(pluginRoot, "empty-agents");
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(pluginRoot, "skills/audit/agents"), "dir");

  const bundle = validatePluginBundle(topology, plugin);

  assert.match(bundle.errors.join("\n"), /agents\/openai\.yaml contains a symbolic link/);
});

test("bundle validates Skill frontmatter and optional UI content", (t) => {
  const { pluginRoot, topology, plugin } = createSingleBundleFixture(t, "alpha", { skills: ["audit"] });
  writeText(path.join(pluginRoot, "skills/audit/SKILL.md"), [
    "---",
    "name: other-name",
    "description: short",
    "---",
    "",
    "[TODO: replace this placeholder]",
  ].join("\n"));
  writeText(
    path.join(pluginRoot, "skills/audit/agents/openai.yaml"),
    "interface:\n  default_prompt: Use the wrong skill.\n",
  );

  const bundle = validatePluginBundle(topology, plugin);
  const errors = bundle.errors.join("\n");

  assert.match(errors, /frontmatter name must match its directory/);
  assert.match(errors, /description is incomplete/);
  assert.match(errors, /contains TODO placeholders/);
  assert.match(errors, /default_prompt must mention \$audit/);
});

test("bundle accumulates missing, mismatched-name, and missing-description manifest diagnostics", async (t) => {
  await t.test("missing manifest", (t) => {
    const { pluginRoot, topology, plugin } = createSingleBundleFixture(t);
    fs.rmSync(path.join(pluginRoot, ".codex-plugin/plugin.json"));
    let bundle;
    assert.doesNotThrow(() => {
      bundle = validatePluginBundle(topology, plugin);
    });
    assert.match(bundle.errors.join("\n"), /plugin\.json cannot be accessed/);
  });

  await t.test("manifest name mismatch", (t) => {
    const { pluginRoot, topology, plugin } = createSingleBundleFixture(t);
    writeJson(path.join(pluginRoot, ".codex-plugin/plugin.json"), pluginManifest("other-name"));
    let bundle;
    assert.doesNotThrow(() => {
      bundle = validatePluginBundle(topology, plugin);
    });
    assert.match(bundle.errors.join("\n"), /names must match/);
  });

  await t.test("missing description", (t) => {
    const { pluginRoot, topology, plugin } = createSingleBundleFixture(t);
    const manifest = pluginManifest("alpha");
    delete manifest.description;
    writeJson(path.join(pluginRoot, ".codex-plugin/plugin.json"), manifest);
    let bundle;
    assert.doesNotThrow(() => {
      bundle = validatePluginBundle(topology, plugin);
    });
    assert.match(bundle.errors.join("\n"), /plugin\.json is missing description/);
  });
});

test("bundle rejects an escaping skills declaration and symbolic-link skills root", async (t) => {
  await t.test("skills escape", (t) => {
    const { pluginRoot, topology, plugin } = createSingleBundleFixture(t, "alpha", { skills: ["audit"] });
    const manifest = pluginManifest("alpha", "../outside-skills");
    writeJson(path.join(pluginRoot, ".codex-plugin/plugin.json"), manifest);
    let bundle;
    assert.doesNotThrow(() => {
      bundle = validatePluginBundle(topology, plugin);
    });
    assert.match(bundle.errors.join("\n"), /skills must not contain \.\./);
    assert.equal(bundle.skillsRoot, null);
  });

  await t.test("skills root link", (t) => {
    const { pluginRoot, topology, plugin } = createSingleBundleFixture(t, "alpha", { skills: ["audit"] });
    const skillsRoot = path.join(pluginRoot, "skills");
    const target = path.join(pluginRoot, "skills-target");
    fs.renameSync(skillsRoot, target);
    fs.symlinkSync(target, skillsRoot, "dir");
    let bundle;
    assert.doesNotThrow(() => {
      bundle = validatePluginBundle(topology, plugin);
    });
    assert.match(bundle.errors.join("\n"), /skills contains a symbolic link/);
    assert.equal(bundle.skillsRoot, null);
  });
});

test("malformed Marketplace input accumulates diagnostics without throwing", (t) => {
  const root = createFixture(t);
  writeText(path.join(root, ".agents/plugins/marketplace.json"), "{not-json\n");

  let topology;
  assert.doesNotThrow(() => {
    topology = validateMarketplaceTopology(root);
  });
  assert.match(topology.errors.join("\n"), /cannot read JSON/);
  assert.doesNotThrow(() => validateMarketplace(root));
});

test("validator layers return diagnostics instead of throwing for invalid invocation input", () => {
  let topology;
  assert.doesNotThrow(() => {
    topology = validateMarketplaceTopology(null);
  });
  assert.match(topology.errors.join("\n"), /Marketplace root must be a non-empty path string/);

  let bundle;
  assert.doesNotThrow(() => {
    bundle = validatePluginBundle(null, null);
  });
  assert.match(bundle.errors.join("\n"), /Plugin bundle descriptor is invalid/);

  assert.doesNotThrow(() => validateFrontendEngineeringStandard(null, null));
  assert.doesNotThrow(() => validateRepositoryRelease(null, null));
  assert.doesNotThrow(() => validateMarketplace(null));
});

test("repository release requires stable documentation to match the package version", (t) => {
  const fixture = createRepositoryReleaseFixture(t, "1.0.1");
  writeText(
    path.join(fixture.root, "docs/getting-started.md"),
    "# Getting started\n\ncodex plugin install frontend-engineering-standard@ai-marketplace --ref v1.0.0\n",
  );
  writeText(path.join(fixture.root, "CHANGELOG.md"), "# Changelog\n\n## 1.0.0 - 2026-07-01\n");

  const result = validateRepositoryRelease(fixture.topology, fixture.bundles);

  assert.ok(result.errors.includes("getting-started: stable installation must pin v1.0.1"));
  assert.ok(result.errors.includes("CHANGELOG: missing 1.0.1 release heading"));
  assert.equal(result.errors.length, 2, result.errors.join("\n"));
});

test("public hygiene traversal skips external file and directory symbolic links", (t) => {
  const root = createFixture(t);
  writeMarketplace(root, [marketplaceEntry("frontend-engineering-standard")]);
  writePlugin(root, "frontend-engineering-standard");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-external-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  writeText(path.join(outside, "secret.txt"), `sk-${"a".repeat(30)}\n`);
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "linked-secret.txt"), "file");
  fs.symlinkSync(outside, path.join(root, "linked-directory"), "dir");
  const topology = validateMarketplaceTopology(root);
  const bundles = topology.plugins.map((plugin) => validatePluginBundle(topology, plugin));

  let result;
  assert.doesNotThrow(() => {
    result = validateRepositoryRelease(topology, bundles);
  });
  assert.doesNotMatch(result.errors.join("\n"), /linked-secret|credential-like/);
});

test("validator never reads files swapped to external symbolic links after validation", async (t) => {
  const createExternalFile = (t, name, content) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-read-swap-"));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const file = path.join(outside, name);
    writeText(file, content);
    return file;
  };

  await t.test("plugin manifest", (t) => {
    const { pluginRoot, topology, plugin } = createSingleBundleFixture(t);
    const manifest = path.join(pluginRoot, ".codex-plugin/plugin.json");
    const marker = "EXTERNAL_VALIDATOR_MANIFEST_MARKER";
    const external = createExternalFile(t, "plugin.json", JSON.stringify({
      ...pluginManifest("alpha"),
      marker,
    }));

    const observed = withControlledFileSwap({
      file: manifest,
      externalFile: external,
      marker,
      trigger: "after-realpath",
    }, () => validatePluginBundle(topology, plugin));

    assert.equal(observed.swapped, true);
    assert.equal(observed.markerRead, false, "external manifest marker must not be read");
    assert.equal(observed.value.manifest, null);
    assert.doesNotMatch(observed.value.errors.join("\n"), new RegExp(marker));
  });

  await t.test("Markdown document", (t) => {
    const fixture = createStandardGateFixture(t);
    const document = path.join(fixture.root, "docs/swap-note.md");
    const marker = "EXTERNAL_VALIDATOR_MARKDOWN_MARKER";
    writeText(document, "# Safe local document\n");
    const external = createExternalFile(t, "swap-note.md", `[marker](missing-${marker}.md)\n`);

    const observed = withControlledFileSwap({
      file: document,
      externalFile: external,
      marker,
      trigger: "after-realpath",
    }, () => validateRepositoryRelease(fixture.topology, fixture.bundles));

    const errors = observed.value.errors.join("\n");
    assert.equal(observed.swapped, true);
    assert.equal(observed.markerRead, false, "external Markdown marker must not be read");
    assert.match(errors, /docs\/swap-note\.md/);
    assert.doesNotMatch(errors, new RegExp(marker));
  });

  await t.test("ordinary public file", (t) => {
    const fixture = createStandardGateFixture(t);
    const publicFile = path.join(fixture.root, "public-note.txt");
    const marker = "EXTERNAL_VALIDATOR_PUBLIC_MARKER";
    writeText(publicFile, "safe public text\n");
    const external = createExternalFile(t, "public-note.txt", `${marker}\nsk-${"a".repeat(30)}\n`);

    const observed = withControlledFileSwap({
      file: publicFile,
      externalFile: external,
      marker,
      trigger: "after-second-lstat",
    }, () => validateRepositoryRelease(fixture.topology, fixture.bundles));

    const errors = observed.value.errors.join("\n");
    assert.equal(observed.swapped, true);
    assert.equal(observed.markerRead, false, "external public-file marker must not be read");
    assert.match(errors, /public-note\.txt/);
    assert.doesNotMatch(errors, new RegExp(marker));
  });
});

test("repository release rejects Markdown links outside the Marketplace trust root", async (t) => {
  const createOutsideFile = (t, content = "external documentation\n") => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-link-target-"));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const file = path.join(outside, "outside.md");
    writeText(file, content);
    return file;
  };

  await t.test("URL-decoded absolute path", (t) => {
    const fixture = createStandardGateFixture(t);
    const absolute = path.join(fixture.root, "absolute-target.md");
    writeText(absolute, "absolute documentation target\n");
    writeText(path.join(fixture.root, "README.md"), `[absolute](${encodeURIComponent(absolute)})\n`);

    const result = validateRepositoryRelease(fixture.topology, fixture.bundles);

    assert.match(result.errors.join("\n"), /README\.md: unsafe documentation link/);
  });

  await t.test("parent-directory escape", (t) => {
    const fixture = createStandardGateFixture(t);
    const outside = createOutsideFile(t);
    const target = path.relative(fixture.root, outside).split(path.sep).join("/");
    assert.match(target, /^\.\.\//);
    writeText(path.join(fixture.root, "README.md"), `[outside](${target})\n`);

    const result = validateRepositoryRelease(fixture.topology, fixture.bundles);

    assert.match(result.errors.join("\n"), /README\.md: unsafe documentation link/);
  });

  await t.test("external symbolic-link target", (t) => {
    const fixture = createStandardGateFixture(t);
    const outside = createOutsideFile(t);
    const linked = path.join(fixture.root, "docs/external.md");
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(outside, linked, "file");
    writeText(path.join(fixture.root, "README.md"), "[outside](docs/external.md)\n");

    const result = validateRepositoryRelease(fixture.topology, fixture.bundles);

    assert.match(result.errors.join("\n"), /README\.md: unsafe documentation link/);
  });
});

const INVALID_VALIDATOR_OPTIONS = [
  { name: "missing root value", args: ["--root"], error: /Missing value for --root/ },
  {
    name: "duplicate root option",
    args: ["--root", ROOT, `--root=${ROOT}`],
    error: /Duplicate option: --root/,
  },
  { name: "unknown option", args: ["--unknown", ROOT], error: /Unknown option: --unknown/ },
  { name: "positional argument", args: [ROOT], error: new RegExp(`Unexpected argument: ${ROOT}`) },
];

for (const fixture of INVALID_VALIDATOR_OPTIONS) {
  test(`validator CLI rejects ${fixture.name}`, () => {
    const result = runValidator(fixture.args);

    assert.equal(result.status, 2);
    assert.match(result.stderr, fixture.error);
  });
}

test("validator CLI accepts spaced and inline root options", async (t) => {
  for (const args of [["--root", ROOT], [`--root=${ROOT}`]]) {
    await t.test(args.join(" "), () => {
      const result = runValidator(args);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Validation passed/);
    });
  }

  const selectedRoot = createFixture(t);
  for (const args of [["--root", selectedRoot], [`--root=${selectedRoot}`]]) {
    await t.test(`applies ${args[0].includes("=") ? "inline" : "spaced"} value`, () => {
      const result = runValidator(args);

      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(selectedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  }
});

test("validator CLI executes through a symbolic link", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-validator-link-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const linkedValidator = path.join(directory, "validate-marketplace.mjs");
  fs.symlinkSync(VALIDATOR, linkedValidator, "file");

  const result = runValidator(["--root", ROOT], linkedValidator);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Validation passed/);
});

test("frontend standard gate accepts complete self-contained assets", (t) => {
  const { topology, bundles } = createStandardGateFixture(t);

  const result = validateFrontendEngineeringStandard(topology, bundles);

  assert.deepEqual(result.errors, []);
});

test("frontend standard gate requires runtime, non-empty skills, and UI metadata", async (t) => {
  await t.test("runtime", (t) => {
    const fixture = createStandardGateFixture(t);
    fs.rmSync(path.join(fixture.pluginRoot, STANDARD_RUNTIME_FILES[0]));
    const result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
    assert.match(result.errors.join("\n"), /scripts\/marketplace-cli\.mjs/);
  });

  await t.test("skills", (t) => {
    const fixture = createStandardGateFixture(t, { skills: [] });
    const result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
    assert.match(result.errors.join("\n"), /non-empty skills directory is required/);
  });

  await t.test("UI metadata", (t) => {
    const fixture = createStandardGateFixture(t, { ui: false });
    const result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
    assert.match(result.errors.join("\n"), /audit: agents\/openai\.yaml is required/);
  });
});

test("frontend standard gate validates all schemas and their canonical identities", async (t) => {
  await t.test("missing schema", (t) => {
    const fixture = createStandardGateFixture(t);
    fs.rmSync(path.join(fixture.pluginRoot, "schemas/project-config.schema.json"));
    const result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
    assert.match(result.errors.join("\n"), /project-config\.schema\.json/);
  });

  await t.test("dialect and id", (t) => {
    const fixture = createStandardGateFixture(t);
    writeJson(path.join(fixture.pluginRoot, "schemas/rule-report.schema.json"), {
      $schema: "https://example.invalid/schema",
      $id: "https://example.invalid/rule-report.schema.json",
      type: "object",
    });
    const result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
    assert.match(result.errors.join("\n"), /rule-report\.schema\.json: \$schema must be/);
    assert.match(result.errors.join("\n"), /rule-report\.schema\.json: \$id must be/);
  });

  await t.test("schema symbolic link", (t) => {
    const fixture = createStandardGateFixture(t);
    const schema = path.join(fixture.pluginRoot, "schemas/impact-report.schema.json");
    const target = path.join(fixture.pluginRoot, "schemas/impact-target.json");
    fs.renameSync(schema, target);
    fs.symlinkSync(target, schema, "file");
    const result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
    assert.match(result.errors.join("\n"), /impact-report\.schema\.json contains a symbolic link/);
  });
});

test("frontend standard gate rejects every missing or symbolic-link required schema", async (t) => {
  for (const file of CONTRACT_FILES) {
    await t.test(`missing ${file}`, (t) => {
      const fixture = createStandardGateFixture(t);
      fs.rmSync(path.join(fixture.pluginRoot, "schemas", file));
      let result;
      assert.doesNotThrow(() => {
        result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
      });
      const errors = result.errors.join("\n");
      assert.ok(errors.includes(file), errors);
      assert.match(errors, /cannot be accessed/);
    });

    await t.test(`symbolic-link ${file}`, (t) => {
      const fixture = createStandardGateFixture(t);
      const schema = path.join(fixture.pluginRoot, "schemas", file);
      const target = path.join(fixture.pluginRoot, "schemas", `${file}.target`);
      fs.renameSync(schema, target);
      fs.symlinkSync(target, schema, "file");
      let result;
      assert.doesNotThrow(() => {
        result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
      });
      const errors = result.errors.join("\n");
      assert.ok(errors.includes(file), errors);
      assert.match(errors, /contains a symbolic link/);
    });
  }
});

test("frontend standard gate validates registry shape and safe test references", async (t) => {
  await t.test("registry top-level shape", (t) => {
    const fixture = createStandardGateFixture(t);
    writeJson(path.join(fixture.pluginRoot, "rules/registry.json"), {
      schemaVersion: "2.0",
      families: {},
    });
    const result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
    assert.match(result.errors.join("\n"), /registry\.json: schemaVersion must be 1\.0/);
    assert.match(result.errors.join("\n"), /registry\.json: families must be an array/);
  });

  await t.test("registry requires at least one family", (t) => {
    const fixture = createStandardGateFixture(t);
    writeJson(path.join(fixture.pluginRoot, "rules/registry.json"), {
      schemaVersion: "1.0",
      families: [],
    });
    let result;
    assert.doesNotThrow(() => {
      result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
    });
    assert.match(result.errors.join("\n"), /registry\.json: families must be a non-empty array/);
  });

  await t.test("registry symbolic link", (t) => {
    const fixture = createStandardGateFixture(t);
    const registry = path.join(fixture.pluginRoot, "rules/registry.json");
    const target = path.join(fixture.pluginRoot, "rules/registry-target.json");
    fs.renameSync(registry, target);
    fs.symlinkSync(target, registry, "file");
    const result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
    assert.match(result.errors.join("\n"), /registry\.json contains a symbolic link/);
  });

  await t.test("missing registry", (t) => {
    const fixture = createStandardGateFixture(t);
    fs.rmSync(path.join(fixture.pluginRoot, "rules/registry.json"));
    let result;
    assert.doesNotThrow(() => {
      result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
    });
    assert.match(result.errors.join("\n"), /registry\.json cannot be accessed/);
  });

  const invalidPaths = [
    ["absolute", "/tmp/outside.test.mjs", /repository-relative POSIX path/],
    ["parent", "../outside.test.mjs", /repository-relative POSIX path/],
    ["backslash", "tests\\standard-gate.test.mjs", /repository-relative POSIX path/],
    ["missing", "tests/missing.test.mjs", /cannot be accessed/],
    ["case", "tests/Standard-gate.test.mjs", /path casing does not match/],
    ["dot-prefix case", "./Tests/standard-gate.test.mjs", /path casing does not match/],
  ];
  for (const [name, registryPath, expected] of invalidPaths) {
    await t.test(name, (t) => {
      const fixture = createStandardGateFixture(t);
      writeRegistry(fixture.pluginRoot, [registryPath]);
      const result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
      assert.match(result.errors.join("\n"), expected);
    });
  }

  await t.test("duplicate and empty family tests", (t) => {
    const fixture = createStandardGateFixture(t);
    writeJson(path.join(fixture.pluginRoot, "rules/registry.json"), {
      schemaVersion: "1.0",
      families: [
        {
          familyId: "duplicate",
          tests: ["tests/standard-gate.test.mjs", "./tests/./standard-gate.test.mjs"],
        },
        { familyId: "empty", tests: [] },
      ],
    });
    const result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
    assert.match(result.errors.join("\n"), /duplicate test path/);
    assert.match(result.errors.join("\n"), /empty: tests must be a non-empty array/);
  });

  await t.test("allowed dot segments normalize to the real repository test path", (t) => {
    const fixture = createStandardGateFixture(t);
    writeRegistry(fixture.pluginRoot, ["./tests/./standard-gate.test.mjs"]);
    const result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
    assert.deepEqual(result.errors, []);
  });

  await t.test("test file symbolic link", (t) => {
    const fixture = createStandardGateFixture(t);
    const target = path.join(fixture.root, "tests/actual.test.mjs");
    const linked = path.join(fixture.root, "tests/linked.test.mjs");
    writeText(target, "export const actual = true;\n");
    fs.symlinkSync(target, linked, "file");
    writeRegistry(fixture.pluginRoot, ["tests/linked.test.mjs"]);
    const result = validateFrontendEngineeringStandard(fixture.topology, fixture.bundles);
    assert.match(result.errors.join("\n"), /contains a symbolic link/);
  });
});

test("repository release gates remain independent from contracts", () => {
  const topology = validateMarketplaceTopology(ROOT);
  const bundles = topology.plugins.map((plugin) => validatePluginBundle(topology, plugin));
  const result = validateRepositoryRelease(topology, bundles);
  assert.deepEqual([...topology.errors, ...bundles.flatMap((bundle) => bundle.errors), ...result.errors], []);
});

test("public marketplace aggregate passes all gates", () => {
  const result = validateMarketplace(ROOT);
  assert.deepEqual(result.errors, []);
});

test("real frontend standard schemas and registry pass the dedicated gate", () => {
  const topology = validateMarketplaceTopology(ROOT);
  const bundles = topology.plugins.map((plugin) => validatePluginBundle(topology, plugin));
  const result = validateFrontendEngineeringStandard(topology, bundles);
  assert.deepEqual([...topology.errors, ...bundles.flatMap((bundle) => bundle.errors), ...result.errors], []);
});
