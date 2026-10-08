// AC-RUA-002 and AC-RUA-021, e2e halves (design §14 rows 002 and 021; BR-RUA-010..015, -023,
// -025, -026, -027): the real-cloud transport probe in `us-east-1`. NOT OFFLINE and never part of
// `npm run check`: it runs only under `npm run test:e2e` with `RUA_E2E_ENV` and
// `RUA_E2E_CONFIRM=<transport_probe_id>` of a probe the operator admitted with
// `rua probe admit --env "$RUA_E2E_ENV" --payment <file> --approved-decision <file>`.
//
// The driver executes the admitted probe (`probe execute … --confirm-cloud-mutation <id>`), then
// verifies its package (`probe verify`), and reads the frozen probe result:
// - ac002-real-probe: the provider commits and the application timer wins; the six conditions
//   BR-RUA-010..015 are evaluated from frozen evidence, verified fidelity names CA-1 and
//   `causal_plus_cross_source_clock_assumption`, ordering is `cross_source_wall_clock`, and no
//   member claims a happened-before proof or an AWS clock guarantee;
// - ac021-real-probe-pass: the verdict is `pass` with every condition passing, valid probe
//   validity, verified fidelity and evidence, cardinality 1/1/1 and no BR-RUA-014 safety release,
//   and the probe is usable, so later executions may select it.
// The result checks live in `support/probe-result-assertions.ts`, which the unit suite runs offline
// over the golden passing probe; the golden halves prove the derivations (probe-pass.golden.test.ts).

import assert from 'node:assert/strict';
import process from 'node:process';
import { before, describe, it } from 'node:test';

import { PACKAGE_LAYOUT } from '../../src/evidence-package/package-layout.ts';
import type { ExecutionIdentity, JsonObject } from '../../src/record-contract/primitives.ts';
import { assertCommitBeforeTimerResult, assertQualificationPassResult } from './support/probe-result-assertions.ts';
import {
  admittedPackage,
  assertCompleted,
  assertExecuted,
  e2eSettings,
  packageRecord,
  runOperator,
} from './support/rua-operator.ts';
import type { OperatorRun } from './support/rua-operator.ts';

describe('AC-RUA-002 and AC-RUA-021 real-cloud transport probe', () => {
  let execute: OperatorRun;
  let verify: OperatorRun;
  let probeResult: JsonObject;
  let probe: ExecutionIdentity;

  before(async () => {
    const { confirmed_id: probeId } = e2eSettings(process.env);
    probe = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: probeId };
    const packageDirectory = admittedPackage(probe);
    execute = await runOperator(['probe', 'execute', packageDirectory, '--confirm-cloud-mutation', probeId]);
    verify = await runOperator(['probe', 'verify', packageDirectory]);
    probeResult = packageRecord(
      packageDirectory,
      PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'transportProbeResult'),
      'transport_probe_result',
    );
  });

  it('ac002-real-probe', () => {
    assertExecuted(execute, probe);
    assertCommitBeforeTimerResult(probeResult);
  });

  it('ac021-real-probe-pass', () => {
    assertExecuted(execute, probe);
    assertQualificationPassResult(probeResult);
    assertCompleted(verify);
    const usability = verify.result.result_record;
    assert.ok(usability !== undefined);
    assert.equal(usability['probe_usability'], 'usable', JSON.stringify(usability['reasons']));
    assert.equal(usability['safety_status'], 'within_limits');
    assert.equal(usability['package_eligibility'], 'eligible');
  });
});
