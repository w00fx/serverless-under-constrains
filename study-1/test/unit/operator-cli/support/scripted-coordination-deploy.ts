// Named fake of the coordination baseline deploy (design §9.1; production:
// `CoordinationBaselineDeployer` through `createAwsCoordinationDeploy`): it answers one scripted
// deploy report and counts the deploys asked for, so a test proves a refused confirmation never
// reached the deploy. Its conformance test (`scripted-coordination-fakes.test.ts`) holds its report
// to the `DeployReport` shape the real deployer returns.

import type { DeployReport } from '../../../../src/deployment-assembly/assembly-ports.ts';
import type { UtcMillis } from '../../../../src/record-contract/primitives.ts';

/** The stack the baseline deploys. */
export const COORDINATION_STACK = 'suc-study-1-coordination';

/**
 * A deploy report of the coordination stack.
 *
 * @example
 * coordinationReport({ deployed: false, reasons: [] }).outputs; // []
 */
export function coordinationReport(overrides: Partial<DeployReport> = {}): DeployReport {
  return {
    stack_name: COORDINATION_STACK,
    deployed: true,
    started_at: '2026-10-06T11:58:00.000Z' as UtcMillis,
    completed_at: '2026-10-06T11:59:30.000Z' as UtcMillis,
    outputs: [
      { key: 'CoordinationTableArn', value: 'arn:aws:dynamodb:us-east-1:012345678901:table/suc-study-1-coordination' },
    ],
    reasons: [],
    ...overrides,
  };
}

export class ScriptedCoordinationDeploy {
  readonly #report: DeployReport;
  #deploys = 0;

  constructor(report: DeployReport = coordinationReport()) {
    this.#report = report;
  }

  /** How many deploys ran. */
  deploys(): number {
    return this.#deploys;
  }

  /** The `CoordinationDeploy` bound to this fake. */
  readonly deploy = (): Promise<DeployReport> => {
    this.#deploys += 1;
    return Promise.resolve(this.#report);
  };
}
