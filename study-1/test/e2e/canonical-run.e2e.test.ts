// AC-RUA-027, e2e half (design §14 row 027; BR-RUA-007, -031, -054): the canonical four-cell run
// in `us-east-1`. NOT OFFLINE and never part of `npm run check`: it runs only under
// `npm run test:e2e` with `RUA_E2E_ENV` and `RUA_E2E_CONFIRM=<run_id>` of a run the operator
// admitted with `rua run admit --env "$RUA_E2E_ENV" --probe <id> --probe-index <sha256> …`,
// selecting the usable probe the transport-probe driver produced.
//
// The driver executes the admitted run (`run execute … --confirm-cloud-mutation <id>`), then
// verifies its original package with the selection its manifest froze (`run verify`), and reads
// the run summary: with all four trial results settled and every validity, integrity,
// late-evidence, package, cleanup, audit, lease and safety check done, the study is `complete`
// only with `comparison_eligibility = eligible`, cleanup `succeeded`, audit `clean` and lease
// `released`; a treatment `fail` remains an admissible observation. The golden half proves the
// same derivation offline (run-summary.golden.test.ts).

import assert from 'node:assert/strict';
import process from 'node:process';
import { before, describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../src/evidence-package/package-layout.ts';
import { isJsonArray, isJsonObject } from '../../src/record-contract/json-value.ts';
import type { JsonObject } from '../../src/record-contract/primitives.ts';
import {
  admittedPackage,
  assertCompleted,
  e2eSettings,
  packageRecord,
  runOperator,
  stringMember,
} from './support/rua-operator.ts';
import type { OperatorRun } from './support/rua-operator.ts';

describe('AC-RUA-027 real-cloud canonical run', () => {
  let execute: OperatorRun;
  let verify: OperatorRun;
  let summary: JsonObject;

  before(async () => {
    const { confirmed_id: runId } = e2eSettings(process.env);
    const packageDirectory = admittedPackage({ execution_kind: 'RUN', run_id: runId });
    const manifest = packageRecord(packageDirectory, EXECUTION_PATHS.executionManifest, 'execution_manifest');
    execute = await runOperator(['run', 'execute', packageDirectory, '--confirm-cloud-mutation', runId]);
    verify = await runOperator(['run', 'verify', packageDirectory, ...selectionFlags(manifest)]);
    summary = packageRecord(packageDirectory, EXECUTION_PATHS.runSummary, 'run_summary');
  });

  it('ac027-canonical-run', () => {
    assertCompleted(execute);
    const trials = summary['trial_results'];
    assert.ok(isJsonArray(trials) && trials.length === 4, 'four trial results');
    for (const trial of trials) {
      assert.ok(isJsonObject(trial));
      assert.equal(trial['execution_status'], 'completed', JSON.stringify(trial));
      assert.ok(['pass', 'fail'].includes(stringMember(trial, 'preservation_verdict')), JSON.stringify(trial));
    }
    assert.equal(
      summary['comparison_eligibility'],
      'eligible',
      JSON.stringify(summary['comparison_ineligibility_reasons']),
    );
    assertCompleted(verify);
    const completion = verify.result.result_record;
    assert.ok(completion !== undefined);
    assert.equal(completion['study_completion'], 'complete', JSON.stringify(completion['incompletion_reasons']));
    assert.equal(completion['comparison_eligibility'], 'eligible');
    assert.equal(completion['package_eligibility'], 'eligible');
    assert.equal(completion['cleanup_status'], 'succeeded');
    assert.equal(completion['leak_audit_status'], 'clean');
    assert.equal(completion['lease_status'], 'released');
  });
});

// The `run verify` selection flags of the qualification the run's manifest froze.
function selectionFlags(manifest: JsonObject): readonly string[] {
  const qualification = manifest['qualification'];
  assert.ok(isJsonObject(qualification), 'the run manifest freezes its selected qualification');
  const flags = [
    '--probe',
    stringMember(qualification, 'transport_probe_id'),
    '--probe-index',
    stringMember(qualification, 'original_package_index_sha256'),
  ];
  const head = qualification['amendment_head_sha256'];
  return typeof head === 'string' ? [...flags, '--probe-head', head] : flags;
}
