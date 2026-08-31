import * as cdk from "aws-cdk-lib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoordinationApp } from "./cdk-app.ts";
import {
  ALLOWED_REGION,
  COORDINATION_STACK_ID,
} from "./identity.ts";
import type {
  CoordinationCloud,
  CoordinationCommandRequest,
  CoordinationCommandResult,
} from "./types.ts";
import {
  collectDeployedIdentityReasons,
  collectRequestIdentityReasons,
  readDeployedBaseline,
  reject,
} from "./verify.ts";

export async function bootstrapCoordination(
  request: CoordinationCommandRequest,
  cloud: CoordinationCloud,
): Promise<CoordinationCommandResult> {
  const callerAccountId = await cloud.getCallerAccountId();
  const requestReasons = collectRequestIdentityReasons(request, callerAccountId);
  if (requestReasons.length > 0) {
    return reject(requestReasons);
  }

  const { stack, table } = await readDeployedBaseline(cloud);
  const present = stack !== undefined && table !== undefined;
  const absent = stack === undefined && table === undefined;

  if (!present && !absent) {
    return reject([
      {
        code: "coordination_baseline_incompatible",
        category: "coordination",
        expected: "absent or complete matching stack and table",
        observed: {
          stack: stack?.stackId,
          table: table?.tableName,
        },
      },
    ]);
  }

  if (present) {
    const deployedReasons = collectDeployedIdentityReasons(
      callerAccountId,
      ALLOWED_REGION,
      stack,
      table,
    );
    if (deployedReasons.length > 0) {
      return reject(deployedReasons);
    }
    return { status: "already_present" };
  }

  const template = synthesizeCoordinationTemplate(callerAccountId, ALLOWED_REGION);
  await cloud.deploy({ stackId: COORDINATION_STACK_ID, template });
  return { status: "bootstrapped" };
}

export function synthesizeCoordinationTemplate(
  accountId: string,
  region: string,
): Record<string, unknown> {
  const outdir = mkdtempSync(join(tmpdir(), "study-1-coordination-synth-"));
  try {
    const app = createCoordinationApp(
      accountId,
      region,
      new cdk.App({ outdir }),
    );
    const assembly = app.synth();
    return assembly.getStackByName(COORDINATION_STACK_ID).template as Record<
      string,
      unknown
    >;
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}
