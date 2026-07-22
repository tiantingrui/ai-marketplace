import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONFIG_FILE,
  loadProjectConfig,
} from "../plugins/frontend-engineering-standard/scripts/lib/project-config.mjs";
import {
  createTestRepository,
  removeTestRepository,
} from "./test-repository.mjs";

const MAX_CONFIG_BYTES = 1024 * 1024;

test("a missing project configuration keeps built-in defaults", (t) => {
  const repo = createTestRepository({ "package.json": "{}\n" });
  t.after(() => removeTestRepository(repo));

  const result = loadProjectConfig(repo);

  assert.equal(result.loaded, false);
  assert.equal(result.file, null);
  assert.equal(result.config.schemaVersion, "1.0");
});

test("project configuration rejects symbolic links and non-regular files", (t) => {
  const repo = createTestRepository({ "package.json": "{}\n" });
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-project-config-"));
  const externalConfig = path.join(externalDirectory, "config.json");
  t.after(() => {
    removeTestRepository(repo);
    fs.rmSync(externalDirectory, { recursive: true, force: true });
  });
  fs.writeFileSync(externalConfig, '{"schemaVersion":"1.0"}\n');
  fs.symlinkSync(externalConfig, path.join(repo, CONFIG_FILE));

  assert.throws(
    () => loadProjectConfig(repo),
    { message: `${CONFIG_FILE}: must be a regular file inside the repository` },
  );

  fs.rmSync(path.join(repo, CONFIG_FILE));
  fs.mkdirSync(path.join(repo, CONFIG_FILE));
  assert.throws(
    () => loadProjectConfig(repo),
    { message: `${CONFIG_FILE}: must be a regular file inside the repository` },
  );
});

test("project configuration preserves size and JSON diagnostics", (t) => {
  const repo = createTestRepository({ "package.json": "{}\n" });
  const configFile = path.join(repo, CONFIG_FILE);
  t.after(() => removeTestRepository(repo));

  fs.writeFileSync(configFile, Buffer.alloc(MAX_CONFIG_BYTES + 1, 0x20));
  assert.throws(
    () => loadProjectConfig(repo),
    { message: `${CONFIG_FILE}: file is too large` },
  );

  fs.writeFileSync(configFile, "{\n");
  assert.throws(
    () => loadProjectConfig(repo),
    (error) => error instanceof Error && error.message.startsWith(`${CONFIG_FILE}: invalid JSON:`),
  );
});

test("project configuration never reads an atomic replacement after lstat", (t) => {
  const repo = createTestRepository({
    [CONFIG_FILE]: '{"schemaVersion":"1.0"}\n',
  });
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-project-config-race-"));
  const replacement = path.join(externalDirectory, "replacement.json");
  const configFile = path.join(repo, CONFIG_FILE);
  const marker = "EXTERNAL_CONFIG_MARKER_MUST_NOT_BE_READ";
  fs.writeFileSync(replacement, marker);
  t.after(() => {
    removeTestRepository(repo);
    fs.rmSync(externalDirectory, { recursive: true, force: true });
  });

  const originalLstatSync = fs.lstatSync;
  const originalReadFileSync = fs.readFileSync;
  let replacementInstalled = false;
  let markerRead = false;
  fs.lstatSync = function lstatAndReplace(candidate, ...args) {
    const metadata = originalLstatSync.call(fs, candidate, ...args);
    if (!replacementInstalled && path.resolve(String(candidate)) === configFile) {
      fs.renameSync(replacement, configFile);
      replacementInstalled = true;
    }
    return metadata;
  };
  fs.readFileSync = function trackMarkerRead(candidate, ...args) {
    const content = originalReadFileSync.call(fs, candidate, ...args);
    const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
    if (text.includes(marker)) markerRead = true;
    return content;
  };

  let error;
  try {
    loadProjectConfig(repo);
  } catch (caught) {
    error = caught;
  } finally {
    fs.lstatSync = originalLstatSync;
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(replacementInstalled, true);
  assert.equal(markerRead, false, "the replacement marker must never enter a read buffer");
  assert.ok(error instanceof Error);
  assert.equal(error.message, `${CONFIG_FILE}: could not be read safely`);
});
