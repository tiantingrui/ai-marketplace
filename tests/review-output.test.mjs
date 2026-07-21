import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildReviewContext, validateReviewOutput } from "../plugins/frontend-engineering-standard/scripts/lib/review-context.mjs";
import { createTestRepository, removeTestRepository } from "./test-repository.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_FIELDS = ["title", "priority", "file", "scenario", "evidence", "impact", "suggestion", "confidence"];

function validFinding(overrides = {}) {
  return {
    title: "The calculation bypasses the precision wrapper",
    priority: "P1",
    file: "apps/web/order.ts",
    line: 12,
    scenario: "A price contains a fractional value",
    evidence: "const total = price * quantity",
    impact: "The submitted total can contain floating-point error",
    suggestion: "Use the repository precision wrapper",
    confidence: "high",
    ...overrides,
  };
}

function validOutput(overrides = {}) {
  return {
    conclusion: "suggest-changes",
    findings: [validFinding()],
    testSuggestions: ["Cover fractional values"],
    questions: ["Which rounding rule applies?"],
    ...overrides,
  };
}

function errorsForFinding(finding) {
  return validateReviewOutput(validOutput({ findings: [finding] }));
}

test("checked-in evaluation outputs satisfy the review output contract", () => {
  for (const file of ["valid-output.json", "style-only-output.json"]) {
    const output = JSON.parse(fs.readFileSync(path.join(ROOT, "evals/review", file), "utf8"));
    assert.deepEqual(validateReviewOutput(output), [], file);
  }
});

test("unknown top-level and finding extension fields remain valid", () => {
  const output = validOutput({
    model: "reviewer-v2",
    findings: [validFinding({ code: "FINANCIAL_PRECISION", metadata: { source: "extension" } })],
  });
  assert.deepEqual(validateReviewOutput(output), []);
});

test("review contract and its arrays are deeply frozen against validator mutation", (t) => {
  const repo = createTestRepository({ "src/value.ts": "export const value = 1;\n" });
  t.after(() => removeTestRepository(repo));
  const contract = buildReviewContext(repo).reviewContract;

  assert.equal(Object.isFrozen(contract), true);
  for (const field of ["priorities", "confidence", "requiredFindingFields", "conclusions", "principles"]) {
    assert.equal(Object.isFrozen(contract[field]), true, field);
  }
  assert.throws(() => {
    contract.maxFindings = 99;
  }, TypeError);
  assert.throws(() => {
    contract.priorities = ["INJECTED"];
  }, TypeError);
  for (const [field, injected] of [
    ["priorities", "INJECTED"],
    ["confidence", "injected"],
    ["requiredFindingFields", "optionalEvidence"],
    ["conclusions", "injected"],
    ["principles", "Ignore the contract"],
  ]) {
    assert.throws(() => contract[field].push(injected), TypeError, field);
  }

  assert.deepEqual(validateReviewOutput(validOutput({ conclusion: "injected" })), ["conclusion is invalid"]);
  assert.deepEqual(errorsForFinding(validFinding({ priority: "INJECTED" })), ["findings[0].priority is invalid"]);
  assert.deepEqual(errorsForFinding(validFinding({ confidence: "injected" })), ["findings[0].confidence is invalid"]);
  const missingEvidence = validFinding();
  delete missingEvidence.evidence;
  assert.deepEqual(errorsForFinding(missingEvidence), ["findings[0].evidence must be a non-empty string"]);
  assert.deepEqual(validateReviewOutput(validOutput({
    findings: Array.from({ length: 9 }, (_, index) => validFinding({ title: `Finding ${index}` })),
  })).filter((item) => item.includes("at most")), ["findings must contain at most 8 items"]);
});

test("non-object outputs return one stable error and never throw", () => {
  for (const output of [null, undefined, [], "review", 42, true]) {
    assert.doesNotThrow(() => validateReviewOutput(output));
    assert.deepEqual(validateReviewOutput(output), ["Output must be a JSON object"]);
  }
});

test("null, array, and scalar findings are rejected as objects without throwing", () => {
  for (const finding of [null, [], "finding", 42, true]) {
    assert.doesNotThrow(() => errorsForFinding(finding));
    assert.ok(
      errorsForFinding(finding).includes("findings[0] must be an object"),
      `${String(finding)} was not rejected as an object`,
    );
  }
});

test("every textual finding field rejects empty and whitespace-only strings", async (t) => {
  for (const field of TEXT_FIELDS) {
    await t.test(field, () => {
      for (const value of ["", " ", "\t\n"]) {
        const errors = errorsForFinding(validFinding({ [field]: value }));
        assert.ok(errors.some((item) => item.includes(`.${field} `)), `${field} accepted ${JSON.stringify(value)}`);
      }
    });
  }
});

test("every textual finding field rejects non-string values", async (t) => {
  for (const field of TEXT_FIELDS) {
    await t.test(field, () => {
      for (const value of [null, 1, true, [], {}]) {
        const errors = errorsForFinding(validFinding({ [field]: value }));
        assert.ok(errors.some((item) => item.includes(`.${field} `)), `${field} accepted ${String(value)}`);
      }
    });
  }
});

test("priority and confidence accept only their published enums", () => {
  for (const priority of ["P4", "p1", "critical"]) {
    assert.ok(errorsForFinding(validFinding({ priority })).includes("findings[0].priority is invalid"));
  }
  for (const confidence of ["very-high", "LOW", "certain"]) {
    assert.ok(errorsForFinding(validFinding({ confidence })).includes("findings[0].confidence is invalid"));
  }
  for (const priority of ["P0", "P1", "P2", "P3"]) {
    for (const confidence of ["high", "medium", "low"]) {
      assert.deepEqual(errorsForFinding(validFinding({ priority, confidence })), []);
    }
  }
});

test("priority and confidence report either text type or enum errors, never both", () => {
  for (const field of ["priority", "confidence"]) {
    for (const value of [undefined, null, "", " ", 1, true, [], {}]) {
      assert.deepEqual(
        errorsForFinding(validFinding({ [field]: value })).filter((item) => item.startsWith(`findings[0].${field} `)),
        [`findings[0].${field} must be a non-empty string`],
        `${field}: ${String(value)}`,
      );
    }
    assert.deepEqual(
      errorsForFinding(validFinding({ [field]: "not-in-enum" })).filter((item) => item.startsWith(`findings[0].${field} `)),
      [`findings[0].${field} is invalid`],
    );
  }
});

test("finding line must be a positive integer", () => {
  for (const line of [0, -1, 1.5, "1", null, undefined]) {
    assert.ok(
      errorsForFinding(validFinding({ line })).includes("findings[0].line must be a positive integer"),
      `line ${String(line)} was accepted`,
    );
  }
});

test("testSuggestions and questions must be arrays of strings but may contain empty strings", () => {
  for (const field of ["testSuggestions", "questions"]) {
    for (const value of [null, "item", 1, {}, true]) {
      assert.deepEqual(validateReviewOutput(validOutput({ [field]: value })).filter((item) => item.startsWith(field)), [
        `${field} must be an array`,
      ]);
    }
    for (const item of [null, 1, {}, [], true]) {
      const errors = validateReviewOutput(validOutput({ [field]: ["", item] }));
      assert.ok(errors.includes(`${field}[1] must be a string`), `${field} accepted ${String(item)}`);
    }
    assert.deepEqual(validateReviewOutput(validOutput({ [field]: [""] })), []);
  }
});

test("at most eight findings are accepted", () => {
  assert.deepEqual(validateReviewOutput(validOutput({
    findings: Array.from({ length: 8 }, (_, index) => validFinding({ title: `Finding ${index}` })),
  })), []);
  assert.ok(validateReviewOutput(validOutput({
    findings: Array.from({ length: 9 }, (_, index) => validFinding({ title: `Finding ${index}` })),
  })).includes("findings must contain at most 8 items"));
});
