#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { validateReviewOutput } from "../plugins/frontend-engineering-standard/scripts/lib/review-context.mjs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: evaluate-review-output.mjs <review.json>");
  process.exit(2);
}

try {
  const output = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const errors = validateReviewOutput(output);
  if (errors.length > 0) {
    errors.forEach((error) => console.error(`ERROR ${error}`));
    process.exitCode = 1;
  } else {
    console.log("Review output contract passed");
  }
} catch (error) {
  console.error(`Review output validation failed: ${error.message}`);
  process.exitCode = 2;
}
