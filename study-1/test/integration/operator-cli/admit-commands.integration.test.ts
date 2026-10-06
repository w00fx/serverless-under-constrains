// The admit commands over the production `admitExecution` (design §11, §10.1): every admission
// port bound to the admission harness's named fakes except the lease read, which is the CLI's
// `EnvironmentLeaseReader` resolving the table from the environment input file. The command builds
// exactly the request the harness's own admission sends, an admitted execution answers exit 0 with
// its manifest, a rejected one exit 3 with its stored rejection. This is also the conformance test
// of `ScriptedExecutionAdmitter`: given the real outcome, the commands report the same result.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AdmissionOutcome, AdmissionRequest, LeaseReadPort } from '../../../src/admission/admission-ports.ts';
import { admitExecution } from '../../../src/admission/admit-execution.ts';
import { AdmitCommand, admitSpec } from '../../../src/operator-cli/admit-commands.ts';
import { EnvironmentLeaseReader } from '../../../src/operator-cli/environment-lease-reader.ts';
import type { ExecutionKind } from '../../../src/record-contract/primitives.ts';
import {
  ENVIRONMENT_INPUT_PATH,
  EVIDENCE_ROOT,
  FOREIGN_ACCOUNT_ID,
  environmentBytes,
  financialRecords,
} from '../../support/admission/admission-fixtures.ts';
import { AdmissionHarness } from '../../support/admission/admission-harness.ts';
import { FakeCallerIdentity } from '../../support/admission/fake-caller-identity.ts';
import { runCli } from '../../unit/operator-cli/support/cli-harness.ts';
import type { CliRun } from '../../unit/operator-cli/support/cli-harness.ts';
import { MemoryInputFileReader } from '../../unit/operator-cli/support/memory-input-file-reader.ts';
import { ScriptedExecutionAdmitter } from '../../unit/operator-cli/support/scripted-execution-admitter.ts';

const PAYMENT_PATH = '/operator/payment.json';
const DECISION_PATH = '/operator/approved-decision.json';

interface AdmittedThroughCli {
  readonly run: CliRun;
  readonly requests: readonly AdmissionRequest[];
  readonly outcomes: readonly AdmissionOutcome[];
  readonly tables: readonly string[];
}

function operatorInputs(): MemoryInputFileReader {
  const records = financialRecords();
  return new MemoryInputFileReader()
    .place(ENVIRONMENT_INPUT_PATH, environmentBytes())
    .place(PAYMENT_PATH, JSON.stringify(records.payment))
    .place(DECISION_PATH, JSON.stringify(records.approved_decision));
}

function argvOf(harness: AdmissionHarness): readonly string[] {
  const argv = [
    ...admitSpec(harness.kind).words,
    '--env',
    ENVIRONMENT_INPUT_PATH,
    '--payment',
    PAYMENT_PATH,
    '--approved-decision',
    DECISION_PATH,
    '--evidence-root',
    EVIDENCE_ROOT,
  ];
  if (harness.kind === 'VARIANT_VALIDATION') {
    argv.push('--variant', harness.request.variant ?? '');
  }
  if (harness.selected === undefined) {
    return argv;
  }
  const selection = harness.selection();
  argv.push('--probe', selection.transport_probe_id, '--probe-index', selection.original_package_index_sha256);
  const head = selection.amendment_head_sha256;
  return head === null ? argv : [...argv, '--probe-head', head];
}

async function admitThroughCli(harness: AdmissionHarness): Promise<AdmittedThroughCli> {
  const inputs = operatorInputs();
  const requests: AdmissionRequest[] = [];
  const outcomes: AdmissionOutcome[] = [];
  const tables: string[] = [];
  const openLease = (tableName: string): LeaseReadPort => {
    tables.push(tableName);
    return harness.lease;
  };
  const command = new AdmitCommand(harness.kind, {
    inputs,
    admit: async (request: AdmissionRequest, evidenceRoot: string): Promise<AdmissionOutcome> => {
      requests.push(request);
      const ports = harness.ports();
      const lease = new EnvironmentLeaseReader({
        inputs,
        environmentPath: request.environment_input_path,
        validator: harness.validator,
        openLease,
      });
      const outcome = await admitExecution(request, {
        ...ports,
        lease,
        paths: { ...ports.paths, evidence_root: evidenceRoot },
      });
      outcomes.push(outcome);
      return outcome;
    },
  });
  return { run: await runCli(argvOf(harness), [command]), requests, outcomes, tables };
}

// The same invocation answered by the scripted fake with the real outcome.
async function scriptedReplay(harness: AdmissionHarness, outcome: AdmissionOutcome): Promise<CliRun> {
  const admitter = new ScriptedExecutionAdmitter(outcome);
  return runCli(argvOf(harness), [new AdmitCommand(harness.kind, { admit: admitter.admit, inputs: operatorInputs() })]);
}

describe('admit commands over production admission', () => {
  for (const kind of ['TRANSPORT_PROBE', 'VARIANT_VALIDATION', 'RUN'] as const satisfies readonly ExecutionKind[]) {
    it(`admits a ${kind} with the request admission itself sends, and writes its package admission`, async () => {
      const harness = await AdmissionHarness.create(kind);
      const admitted = await admitThroughCli(harness);
      assert.equal(admitted.run.exit_code, 0, JSON.stringify(admitted.run.result.reasons));
      assert.deepEqual(admitted.requests, [harness.request]);
      assert.deepEqual(admitted.tables, ['suc-study-1-coordination']);
      const outcome = admitted.outcomes[0];
      assert.ok(outcome?.kind === 'admitted');
      assert.deepEqual(admitted.run.result.written_paths, [outcome.manifest_path]);
      assert.ok((await harness.packagePaths()).includes(outcome.manifest_path));
      assert.deepEqual(harness.mutationLog.entries(), []);
      assert.deepEqual((await scriptedReplay(harness, outcome)).result, admitted.run.result);
    });
  }

  it('reports a rejected run as exit 3 with its stored rejection and no package', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.sts = new FakeCallerIdentity({ account: FOREIGN_ACCOUNT_ID });
    const rejected = await admitThroughCli(harness);
    assert.equal(rejected.run.exit_code, 3);
    const outcome = rejected.outcomes[0];
    assert.ok(outcome?.kind === 'rejected');
    assert.deepEqual(rejected.run.result.written_paths, [outcome.rejection_path]);
    assert.deepEqual(rejected.run.result.reasons, outcome.reasons);
    assert.notEqual(await harness.rejection(outcome.admission_attempt_id), undefined);
    assert.deepEqual(await harness.packagePaths(), []);
    assert.deepEqual((await scriptedReplay(harness, outcome)).result, rejected.run.result);
  });
});
