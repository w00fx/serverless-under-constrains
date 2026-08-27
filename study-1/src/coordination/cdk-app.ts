import * as cdk from "aws-cdk-lib";
import { pathToFileURL } from "node:url";
import {
  ALLOWED_REGION,
  COORDINATION_STACK_ID,
  isTwelveDigitAccountId,
} from "./identity.ts";
import { CoordinationStack } from "./stack.ts";

export function createCoordinationApp(
  accountId = process.env.CDK_DEFAULT_ACCOUNT,
  region = process.env.CDK_DEFAULT_REGION ?? ALLOWED_REGION,
  app: cdk.App = new cdk.App(),
): cdk.App {
  if (region !== ALLOWED_REGION) {
    throw new Error(`coordination CDK app requires region ${ALLOWED_REGION}`);
  }
  if (!isTwelveDigitAccountId(accountId)) {
    throw new Error("coordination CDK app requires an explicit 12-digit account");
  }

  new CoordinationStack(app, COORDINATION_STACK_ID, {
    env: { account: accountId, region },
    stackName: COORDINATION_STACK_ID,
    description:
      "Study 1 baseline coordination lease table. Not run-owned. Operator-managed only.",
  });
  return app;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  createCoordinationApp();
}
