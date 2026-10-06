// The CDK app of the coordination baseline (design §9.1, §11 `coordination bootstrap`). The
// operator deploys it once per account with
// `cdk deploy --app "node infra/bin/coordination-app.ts" suc-study-1-coordination`; run-owned
// execution stacks never include it. The Region is pinned to us-east-1 (BR-RUA-046); the
// account comes from the CDK CLI (`CDK_DEFAULT_ACCOUNT`) and, when present, must be a
// 12-digit account id ([R-aws] STS).

import { App } from 'aws-cdk-lib';

import { COORDINATION_REGION, COORDINATION_STACK_NAME, CoordinationStack } from '../stacks/coordination-stack.ts';

const ACCOUNT_PATTERN = /^[0-9]{12}$/;

export interface CoordinationApp {
  readonly app: App;
  readonly stack: CoordinationStack;
}

/**
 * Builds the coordination app from the CDK CLI environment.
 *
 * @example
 * const { app } = buildCoordinationApp(process.env);
 * app.synth();
 */
export function buildCoordinationApp(
  env: Readonly<Record<string, string | undefined>>,
  outdir?: string,
): CoordinationApp {
  const account = env['CDK_DEFAULT_ACCOUNT'];
  if (account !== undefined && !ACCOUNT_PATTERN.test(account)) {
    throw new Error(`CDK_DEFAULT_ACCOUNT ${JSON.stringify(account)}; expected a 12-digit AWS account id`);
  }
  const app = new App(outdir === undefined ? {} : { outdir });
  const stack = new CoordinationStack(app, COORDINATION_STACK_NAME, {
    stackName: COORDINATION_STACK_NAME,
    env: account === undefined ? { region: COORDINATION_REGION } : { account, region: COORDINATION_REGION },
    description: 'Study 1 coordination baseline: the Study/account/Region lease table (BR-RUA-045). Operator-managed.',
  });
  return { app, stack };
}

if (import.meta.main) {
  buildCoordinationApp(process.env).app.synth();
}
