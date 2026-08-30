import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createApprovedDecision,
  createPayment,
} from "../src/protocol-records/index.ts";

const tablesDir = join(dirname(fileURLToPath(import.meta.url)), "../specs/tables");

const operations = {
  createPayment,
  createApprovedDecision,
} as const;

type Table = {
  id: string;
  requirement: string;
  operation: keyof typeof operations;
  input: unknown;
  expect: { ok: true; value: unknown } | { ok: false; reasons: string[] };
};

const tables = readdirSync(tablesDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(tablesDir, name), "utf8")) as Table);

describe("golden tables", () => {
  for (const table of tables) {
    it(`${table.id} (${table.requirement})`, () => {
      const fn = operations[table.operation];
      assert.equal(typeof fn, "function", table.operation);
      const result = fn(table.input);
      assert.equal(result.ok, table.expect.ok, table.id);
      if (table.expect.ok) {
        assert.ok(result.ok);
        assert.deepEqual(result.value, table.expect.value);
      } else {
        assert.ok(!result.ok);
        assert.deepEqual([...result.reasons].toSorted(), [...table.expect.reasons].toSorted());
      }
    });
  }
});
