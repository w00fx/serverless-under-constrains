import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as coordination from "../src/coordination/index.ts";
import { parseCoordinationCommand } from "../src/coordination/cli.ts";

const studyRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function listTypescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypescriptFiles(path)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

test("AC-23: npm scripts keep bootstrap, verify, and destroy as separate commands", async () => {
  const packageJson = JSON.parse(
    await readFile(join(studyRoot, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts["coordination:bootstrap"],
    "node --experimental-strip-types src/coordination/cli.ts bootstrap",
  );
  assert.equal(
    packageJson.scripts["coordination:verify"],
    "node --experimental-strip-types src/coordination/cli.ts verify",
  );
  assert.equal(
    packageJson.scripts["coordination:destroy"],
    "node --experimental-strip-types src/coordination/cli.ts destroy",
  );
  assert.equal(parseCoordinationCommand(["bootstrap"]), "bootstrap");
  assert.equal(parseCoordinationCommand(["verify"]), "verify");
  assert.equal(parseCoordinationCommand(["destroy"]), "destroy");
  assert.throws(() => parseCoordinationCommand(["migrate"]), /unknown coordination command/);
});

test("AC-23: probe/run public surface cannot import bootstrap or destroy", async () => {
  const exported = Object.keys(coordination).toSorted();
  assert.equal(exported.includes("verifyCoordination"), true);
  assert.equal(exported.includes("parseCoordinationArn"), true);
  assert.equal(exported.includes("bootstrapCoordination"), false);
  assert.equal(exported.includes("destroyCoordination"), false);
  assert.equal(exported.includes("classifyLeaseForDestroy"), false);
  assert.equal(exported.includes("createCoordinationApp"), false);
  assert.equal(exported.includes("dispatchCoordinationCommand"), false);

  const indexSource = await readFile(
    join(studyRoot, "src/coordination/index.ts"),
    "utf8",
  );
  assert.match(indexSource, /verifyCoordination/);
  assert.equal(indexSource.includes("bootstrap"), false);
  assert.equal(indexSource.includes("destroy"), false);
  assert.equal(indexSource.includes("cdk-app"), false);
  assert.equal(indexSource.includes("cli.ts"), false);

  const probeFiles = await listTypescriptFiles(join(studyRoot, "src/probe-admission"));
  for (const file of probeFiles) {
    const source = await readFile(file, "utf8");
    assert.equal(source.includes("coordination/bootstrap"), false, file);
    assert.equal(source.includes("coordination/destroy"), false, file);
    assert.equal(source.includes("coordination/cdk-app"), false, file);
    assert.equal(source.includes("coordination/cli"), false, file);
  }
});

test("AC-23: operator CLI entry points stay command-separated and do not bind live AWS", () => {
  for (const command of ["bootstrap", "verify", "destroy"] as const) {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "src/coordination/cli.ts", command],
      { cwd: studyRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, new RegExp(`coordination:${command}`));
    assert.match(result.stderr, /injected cloud adapter/);
    assert.equal(result.stderr.includes("migrate"), false);
  }
});
