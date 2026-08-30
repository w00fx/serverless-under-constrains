#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, ".metrics-baseline.json");
const update = process.argv.includes("--update");

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function measure() {
  const study1 = join(ROOT, "study-1");
  sh("npx eslint . --max-warnings 0", study1);
  const lintErrors = 0;
  let audit;
  try {
    sh("npm audit --json", study1);
    audit = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  } catch (error) {
    const parsed = JSON.parse(String(error.stdout || "{}"));
    audit = parsed.metadata?.vulnerabilities ?? {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    };
  }
  sh(
    "npx c8 --src src/protocol-records --reporter=json-summary --report-dir coverage-metrics --temp-directory coverage-metrics/.tmp node --experimental-strip-types --test",
    study1,
  );
  const summary = JSON.parse(
    readFileSync(join(study1, "coverage-metrics/coverage-summary.json"), "utf8"),
  ).total;
  return {
    lint_errors: lintErrors,
    npm_audit: {
      info: audit.info,
      low: audit.low,
      moderate: audit.moderate,
      high: audit.high,
      critical: audit.critical,
      total: audit.total,
    },
    coverage: {
      lines: summary.lines.pct,
      branches: summary.branches.pct,
      functions: summary.functions.pct,
      statements: summary.statements.pct,
    },
  };
}

const current = measure();
if (update) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  console.log("updated .metrics-baseline.json");
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const failures = [];

if (current.lint_errors > baseline.lint_errors) {
  failures.push(`lint_errors ${current.lint_errors} > ${baseline.lint_errors}`);
}
for (const key of ["info", "low", "moderate", "high", "critical", "total"]) {
  if (current.npm_audit[key] > baseline.npm_audit[key]) {
    failures.push(`npm_audit.${key} ${current.npm_audit[key]} > ${baseline.npm_audit[key]}`);
  }
}
for (const key of ["lines", "branches", "functions", "statements"]) {
  if (current.coverage[key] + 1e-9 < baseline.coverage[key]) {
    failures.push(`coverage.${key} ${current.coverage[key]} < ${baseline.coverage[key]}`);
  }
}

if (failures.length > 0) {
  console.error("metrics ratchet failed:");
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

const shrinks = [];
if (current.lint_errors < baseline.lint_errors) {
  shrinks.push("lint_errors");
}
for (const key of ["total", "moderate", "high", "critical"]) {
  if (current.npm_audit[key] < baseline.npm_audit[key]) {
    shrinks.push(`npm_audit.${key}`);
  }
}
if (shrinks.length > 0) {
  console.log(`metrics ok; counts shrank (${shrinks.join(", ")}). run: make metrics-update`);
} else {
  console.log("metrics ok; no new lint, audit, or coverage regressions");
}
