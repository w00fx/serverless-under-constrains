import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCoordinationCommand } from "../src/coordination/cli.ts";
import * as coordination from "../src/coordination/index.ts";

const studyRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPERIMENTAL_ROOTS = [
  "src/protocol-records",
  "src/controlled-provider",
  "src/probe",
  "src/validation",
  "src/run",
  "src/cleanup",
  "src/cost",
] as const;
const FORBIDDEN_IMPORTS = [
  "coordination/bootstrap",
  "coordination/destroy",
  "coordination/cdk-app",
  "coordination/cli",
] as const;

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

describe("coordination command separation", () => {
  it("keeps bootstrap, verify, and destroy as separate npm commands", async () => {
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
    assert.throws(() => parseCoordinationCommand([]), /unknown coordination command/);
  });

  it("keeps bootstrap and destroy off the experimental public surface", async () => {
    const exported = Object.keys(coordination).toSorted();
    assert.equal(exported.includes("verifyCoordination"), true);
    assert.equal(exported.includes("parseCoordinationArn"), true);
    assert.equal(exported.includes("bootstrapCoordination"), false);
    assert.equal(exported.includes("destroyCoordination"), false);
    assert.equal(exported.includes("classifyLeaseForDestroy"), false);
    assert.equal(exported.includes("createCoordinationApp"), false);
    assert.equal(exported.includes("dispatchCoordinationCommand"), false);
    assert.equal(exported.includes("COORDINATION_DESTROY_CONFIRMATION"), false);

    const indexSource = await readFile(
      join(studyRoot, "src/coordination/index.ts"),
      "utf8",
    );
    assert.match(indexSource, /verifyCoordination/);
    assert.equal(indexSource.includes("bootstrap"), false);
    assert.equal(indexSource.includes("destroy"), false);
    assert.equal(indexSource.includes("cdk-app"), false);
    assert.equal(indexSource.includes("cli.ts"), false);

    for (const relative of EXPERIMENTAL_ROOTS) {
      const directory = join(studyRoot, relative);
      if (!existsSync(directory)) {
        continue;
      }
      const files = await listTypescriptFiles(directory);
      for (const file of files) {
        const source = await readFile(file, "utf8");
        for (const forbidden of FORBIDDEN_IMPORTS) {
          assert.equal(source.includes(forbidden), false, `${file} ${forbidden}`);
        }
      }
    }
  });

  it("keeps operator CLI entry points command-separated and unbound to live AWS", () => {
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
      if (command === "destroy") {
        assert.match(result.stderr, /DESTROY_BASELINE_COORDINATION/);
      }
    }

    const unknown = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "src/coordination/cli.ts", "migrate"],
      { cwd: studyRoot, encoding: "utf8" },
    );
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown coordination command/);

    const env = { ...process.env };
    delete env.CDK_DEFAULT_ACCOUNT;
    delete env.CDK_DEFAULT_REGION;
    const cdk = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "src/coordination/cdk-app.ts"],
      { cwd: studyRoot, encoding: "utf8", env },
    );
    assert.notEqual(cdk.status, 0);
  });
});
