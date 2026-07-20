import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProjectConfig } from "../plugins/frontend-engineering-standard/scripts/lib/project-config.mjs";
import { createTestRepository, removeTestRepository } from "./test-repository.mjs";

function invalidConfigTest(name, config, expectedMessage) {
  test(name, (t) => {
    const repo = createTestRepository({
      ".ai-marketplace.json": JSON.stringify(config, null, 2),
    });
    t.after(() => removeTestRepository(repo));

    assert.throws(() => loadProjectConfig(repo), new RegExp(expectedMessage));
  });
}

invalidConfigTest(
  "configuration rejects invalid nested field types",
  {
    schemaVersion: "1.0",
    rules: {
      cssUnits: [{ id: "CSS001", pathPrefixes: "apps/", unit: "px" }],
    },
  },
  "rules\\.cssUnits\\[0\\]\\.pathPrefixes must be an array",
);

invalidConfigTest(
  "configuration rejects invalid top-level shapes",
  {
    schemaVersion: "1.0",
    rules: "not-an-object",
  },
  "rules must be an object",
);

invalidConfigTest(
  "configuration rejects repository-escaping paths",
  {
    schemaVersion: "1.0",
    impact: {
      pairedApplications: [{ name: "unsafe", scopes: ["../outside"] }],
    },
  },
  "must stay inside the repository",
);

invalidConfigTest(
  "configuration rejects duplicate deterministic rule ids",
  {
    schemaVersion: "1.0",
    rules: {
      forbiddenImports: [{ id: "IMPORT001", sources: ["legacy-a"] }],
      precisionImports: [{ id: "IMPORT001", sources: ["legacy-b"] }],
    },
  },
  "duplicate rule id: IMPORT001",
);

invalidConfigTest(
  "configuration rejects unknown fields",
  {
    schemaVersion: "1.0",
    rules: {
      packageChangeRemidner: true,
    },
  },
  "rules\\.packageChangeRemidner is not supported",
);

test("configuration rejects symbolic links", (t) => {
  const repo = createTestRepository({ "package.json": "{\"private\":true}\n" });
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-config-"));
  const externalConfig = path.join(externalDirectory, "config.json");
  t.after(() => {
    removeTestRepository(repo);
    fs.rmSync(externalDirectory, { recursive: true, force: true });
  });

  fs.writeFileSync(externalConfig, JSON.stringify({ schemaVersion: "1.0" }));
  fs.symlinkSync(externalConfig, path.join(repo, ".ai-marketplace.json"));

  assert.throws(() => loadProjectConfig(repo), /must be a regular file inside the repository/);
});
