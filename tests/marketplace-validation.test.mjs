import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateMarketplace } from "../scripts/validate-marketplace.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public marketplace identity, version, documentation, and governance pass release gates", () => {
  const result = validateMarketplace(ROOT);
  assert.deepEqual(result.errors, []);
});
