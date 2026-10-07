// Named fake of step A8's read-only coordination reads (design §10.1 A8; production:
// `createAwsCoordinationReader`, DescribeTable, DescribeTimeToLive and the lease GetItem): it
// answers scripted readings and records the environment each read was for. Its conformance test
// (`scripted-coordination-fakes.test.ts`) holds its readings to what `assessCoordination` accepts.

import type { CoordinationReadings } from '../../../../src/admission/coordination-check.ts';
import type { EnvironmentInput } from '../../../../src/record-contract/records/group-a/environment_input.ts';

export class ScriptedCoordinationReader {
  readonly #readings: CoordinationReadings;
  /** The environment of every read, in order. */
  readonly reads: EnvironmentInput[] = [];

  constructor(readings: CoordinationReadings) {
    this.#readings = readings;
  }

  /** The `CoordinationReader` bound to this fake. */
  readonly read = (environment: EnvironmentInput): Promise<CoordinationReadings> => {
    this.reads.push(environment);
    return Promise.resolve(this.#readings);
  };
}
