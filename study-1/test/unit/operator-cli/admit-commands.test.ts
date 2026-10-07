// `rua probe|validation|run admit` (design §11, §10.1): the request each kind builds from its flags
// and input files, the usage errors that stop before admission (a variant or selection that does
// not parse, an input file that cannot be read or is not UTF-8 JSON), and the mapping of
// admission's outcome to the CLI result: admitted 0 with the manifest, rejected 3 with the
// rejection, failed 10.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AdmissionOutcome } from '../../../src/admission/admission-ports.ts';
import { OR_RUA_001_APPROVED_DECISION, OR_RUA_001_PAYMENT } from '../../../src/admission/declared-inputs.ts';
import { AdmitCommand, admissionReport, admitSpec } from '../../../src/operator-cli/admit-commands.ts';
import type { ExecutionKind, Sha256Hex, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { runCli } from './support/cli-harness.ts';
import type { CliRun } from './support/cli-harness.ts';
import { MemoryInputFileReader } from './support/memory-input-file-reader.ts';
import { ScriptedExecutionAdmitter } from './support/scripted-execution-admitter.ts';

const ATTEMPT = '0000a001-0000-4000-8000-000000000001' as Uuid4;
const RUN_ID = '0000a001-0000-4000-8000-000000000002' as Uuid4;
const PROBE_ID = '0000a001-0000-4000-8000-000000000003' as Uuid4;
const INDEX = 'a'.repeat(64);
const HEAD = 'b'.repeat(64);
const ROOT = ['--evidence-root', '/study/evidence'];
const INPUTS = ['--env', 'env.json', '--payment', 'payment.json', '--approved-decision', '/abs/decision.json'];
const SELECTION = ['--probe', PROBE_ID, '--probe-index', INDEX];

const ADMITTED: AdmissionOutcome = {
  kind: 'admitted',
  admission_attempt_id: ATTEMPT,
  manifest_path: `runs/${RUN_ID}/admission/execution-manifest.json`,
  manifest_sha256: 'c'.repeat(64) as Sha256Hex,
  execution: { execution_kind: 'RUN', run_id: RUN_ID },
};
const REASON = { code: 'ACCOUNT_NOT_ALLOWLISTED', subject: 'BR-RUA-041', detail: 'account 1; expected 2' };

function inputFiles(): MemoryInputFileReader {
  return new MemoryInputFileReader()
    .place('/operator/payment.json', JSON.stringify(OR_RUA_001_PAYMENT))
    .place('/abs/decision.json', `${JSON.stringify(OR_RUA_001_APPROVED_DECISION)}\n`);
}

async function admit(
  kind: ExecutionKind,
  argv: readonly string[],
  outcome: AdmissionOutcome = ADMITTED,
  inputs: MemoryInputFileReader = inputFiles(),
): Promise<{ readonly run: CliRun; readonly admitter: ScriptedExecutionAdmitter }> {
  const admitter = new ScriptedExecutionAdmitter(outcome);
  const command = new AdmitCommand(kind, { admit: admitter.admit, inputs });
  return { run: await runCli([...admitSpec(kind).words, ...argv, ...ROOT], [command]), admitter };
}

describe('admitSpec', () => {
  it('requires the inputs of every kind and the selection and variant where the kind has them', () => {
    const presence = (kind: ExecutionKind): readonly (readonly [string, string])[] => [...admitSpec(kind).flags];
    assert.deepEqual(presence('TRANSPORT_PROBE'), [
      ['env', 'required'],
      ['payment', 'required'],
      ['approved-decision', 'required'],
    ]);
    assert.deepEqual(presence('RUN').slice(3), [
      ['probe', 'required'],
      ['probe-index', 'required'],
      ['probe-head', 'optional'],
    ]);
    assert.deepEqual(presence('VARIANT_VALIDATION').slice(3, 5), [
      ['variant', 'required'],
      ['probe', 'required'],
    ]);
    assert.deepEqual(admitSpec('VARIANT_VALIDATION').positionals, []);
    assert.equal(
      admitSpec('VARIANT_VALIDATION').usage,
      'validation admit --env <file> --variant conventional|durable --probe <id> --probe-index <sha256> [--probe-head <sha256>] --payment <file> --approved-decision <file>',
    );
    assert.equal(
      admitSpec('TRANSPORT_PROBE').usage,
      'probe admit --env <file> --payment <file> --approved-decision <file>',
    );
    assert.deepEqual(admitSpec('RUN').words, ['run', 'admit']);
  });
});

describe('admit commands', () => {
  it('admits a probe with the resolved environment input and the parsed financial records', async () => {
    const { run, admitter } = await admit('TRANSPORT_PROBE', INPUTS);
    assert.equal(run.exit_code, 0, JSON.stringify(run.result.reasons));
    assert.deepEqual(admitter.calls, [
      {
        request: {
          kind: 'TRANSPORT_PROBE',
          environment_input_path: '/operator/env.json',
          financial_inputs: { payment: OR_RUA_001_PAYMENT, approved_decision: OR_RUA_001_APPROVED_DECISION },
        },
        evidence_root: '/study/evidence',
      },
    ]);
    assert.deepEqual(run.result.written_paths, [`runs/${RUN_ID}/admission/execution-manifest.json`]);
    assert.equal(run.result.run_id, RUN_ID);
    assert.ok(run.stderr_lines.includes('admitting a TRANSPORT_PROBE with /operator/env.json'));
  });

  it('sends a run its selected probe, with or without a head', async () => {
    const [call] = (await admit('RUN', [...INPUTS, ...SELECTION])).admitter.calls;
    assert.ok(call !== undefined);
    assert.deepEqual(call.request.qualification, {
      transport_probe_id: PROBE_ID,
      original_package_index_sha256: INDEX,
      amendment_head_sha256: null,
    });
    assert.equal(call.request.variant, undefined);
    const [headed] = (await admit('RUN', [...INPUTS, ...SELECTION, '--probe-head', HEAD])).admitter.calls;
    assert.equal(headed?.request.qualification?.amendment_head_sha256, HEAD);
  });

  it('sends a validation its variant and its selected probe', async () => {
    const [call] = (await admit('VARIANT_VALIDATION', [...INPUTS, '--variant', 'conventional', ...SELECTION])).admitter
      .calls;
    assert.ok(call !== undefined);
    assert.equal(call.request.kind, 'VARIANT_VALIDATION');
    assert.equal(call.request.variant, 'conventional');
    assert.equal(call.request.qualification?.transport_probe_id, PROBE_ID);
  });

  it('refuses a variant or a selection that does not parse, before admission', async () => {
    const variant = await admit('VARIANT_VALIDATION', [...INPUTS, '--variant', 'Durable', ...SELECTION]);
    assert.equal(variant.run.exit_code, 2);
    assert.deepEqual(variant.run.result.reasons, [
      {
        code: 'USAGE_ERROR',
        subject: 'operator-cli',
        detail: '--variant "Durable" is not a variant; expected one of conventional, durable',
      },
    ]);
    assert.deepEqual(variant.admitter.calls, []);
    const selection = await admit('VARIANT_VALIDATION', [
      ...INPUTS,
      '--variant',
      'durable',
      '--probe',
      'x',
      '--probe-index',
      INDEX,
    ]);
    assert.equal(selection.run.exit_code, 2);
    assert.match(selection.run.result.reasons[0]?.detail ?? '', /^--probe "x" is not a probe id/);
    const run = await admit('RUN', [...INPUTS, '--probe', PROBE_ID, '--probe-index', 'z']);
    assert.equal(run.run.exit_code, 2);
    assert.deepEqual(run.admitter.calls, []);
  });

  it('refuses a missing required flag before admission', async () => {
    const { run, admitter } = await admit('RUN', INPUTS);
    assert.equal(run.exit_code, 2);
    assert.deepEqual(admitter.calls, []);
  });

  it('names an input file it cannot read, or that is not UTF-8 JSON, with the expected shape', async () => {
    const cases: readonly (readonly [MemoryInputFileReader, string])[] = [
      [
        new MemoryInputFileReader().place('/abs/decision.json', '{}'),
        `--payment "/operator/payment.json" cannot be read: ENOENT: ENOENT: no such file or directory, open '/operator/payment.json'; expected a readable UTF-8 JSON document`,
      ],
      [
        inputFiles().place('/operator/payment.json', new Uint8Array([0xff])),
        '--payment "/operator/payment.json" cannot be read: invalid UTF-8 at byte 0; expected a readable UTF-8 JSON document',
      ],
      [
        new MemoryInputFileReader().place('/operator/payment.json', '{}'),
        `--approved-decision "/abs/decision.json" cannot be read: ENOENT: ENOENT: no such file or directory, open '/abs/decision.json'; expected a readable UTF-8 JSON document`,
      ],
    ];
    for (const [inputs, detail] of cases) {
      const { run, admitter } = await admit('TRANSPORT_PROBE', INPUTS, ADMITTED, inputs);
      assert.equal(run.exit_code, 2);
      assert.deepEqual(run.result.reasons, [{ code: 'USAGE_ERROR', subject: 'operator-cli', detail }]);
      assert.deepEqual(admitter.calls, []);
    }
    const notJson = await admit('TRANSPORT_PROBE', INPUTS, ADMITTED, inputFiles().place('/abs/decision.json', '{'));
    assert.equal(notJson.run.exit_code, 2);
    assert.match(
      notJson.run.result.reasons[0]?.detail ?? '',
      /^--approved-decision "\/abs\/decision.json" cannot be read: .+; expected a readable UTF-8 JSON document$/,
    );
  });

  it('reports a rejection as exit 3 with its stored rejection, and a failed attempt as exit 10', async () => {
    const rejectionPath = `admission-attempts/${ATTEMPT}/admission-rejection.json`;
    const rejected = await admit('TRANSPORT_PROBE', INPUTS, {
      kind: 'rejected',
      admission_attempt_id: ATTEMPT,
      rejection_path: rejectionPath,
      reasons: [REASON],
    });
    assert.equal(rejected.run.exit_code, 3);
    assert.deepEqual(rejected.run.result.written_paths, [rejectionPath]);
    assert.deepEqual(rejected.run.result.reasons, [REASON]);
    const failed = await admit('TRANSPORT_PROBE', INPUTS, {
      kind: 'failed',
      admission_attempt_id: ATTEMPT,
      reasons: [REASON],
    });
    assert.equal(failed.run.exit_code, 10);
    assert.deepEqual(failed.run.result.written_paths, []);
  });
});

describe('admissionReport', () => {
  it('maps every admission outcome to its CLI outcome', () => {
    assert.equal(admissionReport(ADMITTED).outcome, 'completed');
    assert.equal(
      admissionReport({ kind: 'failed', admission_attempt_id: ATTEMPT, reasons: [REASON] }).outcome,
      'internal_failure',
    );
  });
});
