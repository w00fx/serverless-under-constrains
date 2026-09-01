import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src/coordination");

describe("coordination coverage imports", () => {
  it("loads every source file so c8 cannot skip an unimported module", async () => {
    const files = readdirSync(SRC).filter((name) => name.endsWith(".ts")).toSorted();
    assert.ok(files.length > 0);
    for (const name of files) {
      await import(pathToFileURL(join(SRC, name)).href);
    }
  });
});
