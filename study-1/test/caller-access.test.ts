import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as caller from "../src/caller/index.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../src/caller");

const FORBIDDEN = [
  "readLedger",
  "readTreatmentState",
  "processRefundCall",
  "coordination/bootstrap",
  "coordination/destroy",
  "coordination/cdk-app",
  "coordination/cli",
];

async function listTypescript(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypescript(path)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("caller authority boundary", { timeout: 2000 }, () => {
  it("does not import ledger, treatment, or coordination mutation surfaces", async () => {
    const files = await listTypescript(srcRoot);
    assert.ok(files.length > 0);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const token of FORBIDDEN) {
        assert.equal(source.includes(token), false, `${file} contains ${token}`);
      }
    }
  });

  it("exports the shared caller contract and not provider control APIs", () => {
    const exported = Object.keys(caller).toSorted();
    assert.equal(exported.includes("invokeAttempt"), true);
    assert.equal(exported.includes("createAttemptIdentities"), true);
    assert.equal(exported.includes("projectKnowledge"), true);
    assert.equal(exported.includes("projectProcessing"), true);
    assert.equal(exported.includes("readLedger"), false);
    assert.equal(exported.includes("readTreatmentState"), false);
    assert.equal(exported.includes("processRefundCall"), false);
  });
});
