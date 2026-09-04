import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../../src/protocol-records/index.ts";
import { EVIDENCE_INDEX_PATH, PACKAGE_INDEX_PATH } from "../../src/evidence-packages/index.ts";
import { buildEligibleProbe, buildEligibleValidation } from "./evidence-packages/build.ts";

const dir = dirname(fileURLToPath(import.meta.url));

const PINNED = {
  "eligible-probe/package-index.json": "9e6bd1cbb5e2d2f1787e7f70ed8bc7533ec1f2f9ebcf24abc98bd8befd8b6777",
  "eligible-probe/derived/evidence-index.json": "758cd8de4f716cb0351123b0696d9279bbbe5ab7734e06e409e21608f27d7ceb",
  "eligible-validation/package-index.json": "c1a769f2c2f0a5d0bc3633a2e9d6c8b9a74f5629c059713c73a8c26d5e740e14",
  "eligible-validation/derived/evidence-index.json": "dfbb7d338588647d22763fa13edff33fed6e3e5e1ee60a254961f286517bb8a8",
} as const;

describe("locked original evidence-package fixtures", () => {
  it("reproduces exact evidence-index and package-index bytes", () => {
    const packages = {
      "eligible-probe": buildEligibleProbe(),
      "eligible-validation": buildEligibleValidation(),
    } as const;
    for (const [name, store] of Object.entries(packages)) {
      const index = store.get(PACKAGE_INDEX_PATH);
      const evidence = store.get(EVIDENCE_INDEX_PATH);
      assert.notEqual(index, undefined, name);
      assert.notEqual(evidence, undefined, name);
      const indexName = `${name}/package-index.json`;
      const evidenceName = `${name}/derived/evidence-index.json`;
      const storedIndex = readFileSync(join(dir, "evidence-packages", indexName), "utf8");
      const storedEvidence = readFileSync(join(dir, "evidence-packages", evidenceName), "utf8");
      assert.equal(new TextDecoder().decode(index), storedIndex, indexName);
      assert.equal(new TextDecoder().decode(evidence), storedEvidence, evidenceName);
      assert.equal(sha256Hex(storedIndex), PINNED[indexName as keyof typeof PINNED], indexName);
      assert.equal(sha256Hex(storedEvidence), PINNED[evidenceName as keyof typeof PINNED], evidenceName);
    }
  });
});
