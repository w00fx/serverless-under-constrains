// AC-RUA-002 and AC-RUA-021, e2e halves (design §14 rows 002 and 021; BR-RUA-010..015, -023,
// -025, -026, -027): the real-cloud transport probe in `us-east-1`. NOT OFFLINE and never part of
// `npm run check`: it runs only under `npm run test:e2e` with `RUA_E2E_ENV` and
// `RUA_E2E_CONFIRM=<transport_probe_id>` of a probe the operator admitted with
// `rua probe admit --env "$RUA_E2E_ENV" --payment <file> --approved-decision <file>`.
//
// The driver executes the admitted probe (`probe execute … --confirm-cloud-mutation <id>`), then
// verifies its package (`probe verify`), and reads the frozen probe result:
// - ac002-real-probe: the provider commits and the application timer wins; the six conditions are
//   evaluated from frozen evidence, fidelity names CA-1 and
//   `causal_plus_cross_source_clock_assumption`, ordering is `cross_source_wall_clock`, and no
//   member claims a happened-before proof or an AWS clock guarantee;
// - ac021-real-probe-pass: the verdict is `pass` with cardinality 1/1/1, verified evidence, valid
//   fidelity and no safety release, and the probe is usable, so later executions may select it.
// The golden halves prove the same derivations offline (probe-pass.golden.test.ts).

import assert from 'node:assert/strict';
import process from 'node:process';
import { before, describe, it } from 'node:test';

import { PACKAGE_LAYOUT } from '../../src/evidence-package/package-layout.ts';
import { isJsonArray, isJsonObject } from '../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../src/record-contract/primitives.ts';
import { HAPPENED_BEFORE_PATTERN } from '../golden/transport-qualification/verdict/support/probe-golden.ts';
import { admittedPackage, assertCompleted, e2eSettings, packageRecord, runOperator } from './support/rua-operator.ts';
import type { OperatorRun } from './support/rua-operator.ts';

describe('AC-RUA-002 and AC-RUA-021 real-cloud transport probe', () => {
  let execute: OperatorRun;
  let verify: OperatorRun;
  let probeResult: JsonObject;

  before(async () => {
    const { confirmed_id: probeId } = e2eSettings(process.env);
    const packageDirectory = admittedPackage({ execution_kind: 'TRANSPORT_PROBE', transport_probe_id: probeId });
    execute = await runOperator(['probe', 'execute', packageDirectory, '--confirm-cloud-mutation', probeId]);
    verify = await runOperator(['probe', 'verify', packageDirectory]);
    probeResult = packageRecord(
      packageDirectory,
      PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'transportProbeResult'),
      'transport_probe_result',
    );
  });

  it('ac002-real-probe', () => {
    assertCompleted(execute);
    const conditions = probeResult['condition_results'];
    assert.ok(isJsonArray(conditions) && conditions.length === 6, 'six condition results');
    for (const condition of conditions) {
      assert.ok(isJsonObject(condition));
      assert.equal(condition['result'], 'pass', JSON.stringify(condition));
      const refs = condition['evidence_refs'];
      assert.ok(isJsonArray(refs) && refs.length > 0);
    }
    assert.equal(probeResult['fidelity_basis'], 'causal_plus_cross_source_clock_assumption');
    assert.deepEqual(probeResult['clock_assumption_refs'], ['CA-1']);
    assert.equal(probeResult['ordering_basis'], 'cross_source_wall_clock');
    assert.deepEqual(
      memberNames(probeResult).filter((name) => HAPPENED_BEFORE_PATTERN.test(name)),
      [],
    );
  });

  it('ac021-real-probe-pass', () => {
    assertCompleted(execute);
    assert.equal(probeResult['transport_probe_verdict'], 'pass');
    assert.deepEqual(probeResult['probe_cardinality'], {
      caller_invocations: 1,
      accepted_provider_calls: 1,
      committed_transactions: 1,
    });
    assert.equal(probeResult['evidence_integrity'], 'verified');
    assert.equal(probeResult['treatment_fidelity'], 'verified');
    assertCompleted(verify);
    const usability = verify.result.result_record;
    assert.ok(usability !== undefined);
    assert.equal(usability['probe_usability'], 'usable', JSON.stringify(usability['reasons']));
    assert.equal(usability['safety_status'], 'within_limits');
    assert.equal(usability['package_eligibility'], 'eligible');
  });
});

// Every member name of a JSON value, at any depth.
function memberNames(value: JsonValue): readonly string[] {
  if (isJsonArray(value)) {
    return value.flatMap(memberNames);
  }
  if (!isJsonObject(value)) {
    return [];
  }
  return [...Object.keys(value), ...Object.values(value).flatMap(memberNames)];
}
