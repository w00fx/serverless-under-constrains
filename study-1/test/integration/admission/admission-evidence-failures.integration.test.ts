// An attempt whose own evidence cannot be written or read admits nothing (BR-RUA-039, BR-RUA-040,
// BR-RUA-042; design §10.1 A1..A15, §9.8 S2). Admission never continues past a step it could not
// journal, never reports a rejection it could not store, and never writes a manifest after any
// other package file failed; local inputs it cannot read reject with the step's class; the
// synthesized assembly and its package copy are proven readable and identical.
//
// Boundary: the production `admitExecution` over the admission harness, with one fault injected
// into the memory journal, the memory file system, the scripted CDK CLI or one named fake.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AdmissionOutcome } from '../../../src/admission/admission-ports.ts';
import { ATTEMPT_FILES } from '../../../src/admission/admission-attempt.ts';
import { SYNTH_OUTPUT_DIR } from '../../../src/deployment-assembly/cdk-invocations.ts';
import { EXECUTION_DIRECTORIES, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import type { RecordType } from '../../../src/record-contract/record-types.ts';
import { isJsonObject } from '../../../src/record-contract/json-value.ts';
import { stackName } from '../../../infra/ownership/resource-naming.ts';
import {
  ENVIRONMENT_INPUT_PATH,
  EVIDENCE_ROOT,
  STAGING_ROOT,
  financialRecords,
} from '../../support/admission/admission-fixtures.ts';
import { AdmissionHarness, harnessId } from '../../support/admission/admission-harness.ts';
import { FakeSchemaCatalog } from '../../support/admission/fake-schema-catalog.ts';
import { synthesizedAssemblyFiles } from '../../support/admission/synth-templates.ts';

const ATTEMPT = harnessId(1);
const JOURNAL_PATH = `${EVIDENCE_ROOT}/${PACKAGE_LAYOUT.admissionAttemptDirectory(ATTEMPT)}/${ATTEMPT_FILES.preflightJournal}`;
const ASSEMBLY_DIR = `${STAGING_ROOT}/${ATTEMPT}/${SYNTH_OUTPUT_DIR}`;
const RUN_DIRECTORY = `${EVIDENCE_ROOT}/${PACKAGE_LAYOUT.executionDirectory({ execution_kind: 'RUN', run_id: harnessId(2) })}`;
const FROZEN_COPY = `${RUN_DIRECTORY}/${EXECUTION_DIRECTORIES.deploymentAssembly.slice(0, -1)}`;
const TEMPLATE_FILE = `${stackName('RUN', harnessId(2))}.template.json`;

function codes(outcome: AdmissionOutcome): readonly string[] {
  return outcome.kind === 'admitted' ? [] : outcome.reasons.map((reason) => reason.code);
}

// Nothing is admitted: no package file exists and the journal is closed.
async function assertNothingAdmitted(harness: AdmissionHarness, outcome: AdmissionOutcome): Promise<void> {
  assert.notEqual(outcome.kind, 'admitted', JSON.stringify(outcome));
  assert.deepEqual(await harness.packagePaths(), []);
  assert.deepEqual(harness.mutationLog.entries(), []);
}

async function failedCheck(harness: AdmissionHarness): Promise<unknown> {
  const rejection = await harness.rejection(ATTEMPT);
  return isJsonObject(rejection) ? rejection['failed_check_id'] : undefined;
}

describe('an attempt whose evidence cannot be written admits nothing', () => {
  it('journal-unwritable-at-every-step', async () => {
    for (let line = 1; line <= 15; line += 1) {
      const harness = await AdmissionHarness.create('RUN');
      harness.journal.failWriteAt(JOURNAL_PATH, line, 'nothing_written', 'ENOSPC');
      const outcome = await harness.admit();
      assert.equal(outcome.kind, 'failed', `line ${String(line)}: ${JSON.stringify(outcome)}`);
      assert.deepEqual(outcome.reasons, [
        {
          code: 'ADMISSION_EVIDENCE_UNWRITABLE',
          subject: 'BR-RUA-039',
          detail:
            "the attempt's preflight journal could not be written (ENOSPC); expected every admission check recorded",
        },
      ]);
      assert.equal(harness.journalRecords(ATTEMPT).length, line - 1);
      assert.equal(harness.journalFinalized(ATTEMPT), true);
      await assertNothingAdmitted(harness, outcome);
    }
  });

  it('rejection-unwritable', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.request = { ...harness.request, financial_inputs: financialRecords({}, { approved_amount_minor: 1 }) };
    harness.files.failCreate(
      `${EVIDENCE_ROOT}/${PACKAGE_LAYOUT.admissionAttemptDirectory(ATTEMPT)}/${ATTEMPT_FILES.admissionRejection}`,
    );
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'failed');
    assert.deepEqual(codes(outcome), ['ADMISSION_EVIDENCE_UNWRITABLE', 'AMOUNTS_UNEQUAL']);
    assert.match(outcome.reasons[0]?.detail ?? '', /admission rejection could not be written \(IO_ERROR\)/);
    await assertNothingAdmitted(harness, outcome);
  });

  it('rejected-journal-not-finalized', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.git.addUntracked('study-1/notes.txt');
    harness.journal.refuseFinalize(1, 'EPERM');
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'failed');
    assert.deepEqual(codes(outcome), ['ADMISSION_EVIDENCE_UNWRITABLE', 'UNTRACKED_FILE']);
    assert.match(outcome.reasons[0]?.detail ?? '', /preflight journal finalization could not be written \(EPERM\)/);
    await assertNothingAdmitted(harness, outcome);
  });

  it('admitted-journal-not-finalized', async () => {
    const harness = await AdmissionHarness.create('TRANSPORT_PROBE');
    harness.journal.refuseFinalize(1, 'EPERM');
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'failed');
    assert.deepEqual(codes(outcome), ['ADMISSION_EVIDENCE_UNWRITABLE']);
    assert.equal(harness.journalRecords(ATTEMPT).length, 15);
    await assertNothingAdmitted(harness, outcome);
  });

  it('schema-catalog-unreadable', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.schemas.failWith('EACCES', 'schemas/ is not readable');
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'failed');
    assert.deepEqual(codes(outcome), ['SCHEMA_CATALOG_UNREADABLE']);
    assert.equal(harness.journalRecords(ATTEMPT).length, 14);
    assert.equal(harness.journalFinalized(ATTEMPT), true);
    await assertNothingAdmitted(harness, outcome);
  });

  it('schema-catalog-empty', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.schemas = new FakeSchemaCatalog([]);
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'failed');
    assert.deepEqual(outcome.reasons, [
      {
        code: 'SCHEMA_CATALOG_EMPTY',
        subject: 'BR-RUA-040',
        detail: 'the schema catalogue lists no schema; expected every record schema',
      },
    ]);
    await assertNothingAdmitted(harness, outcome);
  });

  it('draft-record-invalid', async () => {
    const harness = await AdmissionHarness.create('RUN');
    const bytes = new TextEncoder().encode('{}\n');
    harness.schemas = new FakeSchemaCatalog([
      { record_type: 'Not A Record' as RecordType, relative_path: '../outside.schema.json', bytes },
    ]);
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'failed');
    assert.ok(codes(outcome).length > 0);
    assert.ok(
      codes(outcome).every((code) => code === 'DRAFT_RECORD_INVALID'),
      JSON.stringify(outcome),
    );
    assert.match(outcome.reasons[0]?.detail ?? '', /^admission\/execution-manifest\.json at \/schema_files/);
    await assertNothingAdmitted(harness, outcome);
  });
});

describe('local inputs that cannot be read reject at their step', () => {
  it('environment-input-unreadable', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.files.failRead(ENVIRONMENT_INPUT_PATH);
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'rejected');
    assert.deepEqual(codes(outcome), ['ENVIRONMENT_INPUT_UNREADABLE']);
    assert.equal(await failedCheck(harness), 'A2');
    await assertNothingAdmitted(harness, outcome);
  });

  it('git-state-unreadable', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.git.failWith('GIT_FAILED', 'git status exited 128');
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'rejected');
    assert.deepEqual(codes(outcome), ['GIT_STATE_UNREADABLE']);
    assert.equal(await failedCheck(harness), 'A5');
    await assertNothingAdmitted(harness, outcome);
  });
});

describe('the assembly is synthesized, read and frozen exactly (A12, S2)', () => {
  it('synthesis-failed', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.runner.enqueue({ kind: 'exited', exit_code: 1, stdout: '', stderr: 'boom' });
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'rejected');
    assert.deepEqual(codes(outcome), ['SYNTH_FAILED']);
    assert.equal(await failedCheck(harness), 'A12');
    await assertNothingAdmitted(harness, outcome);
  });

  it('synthesized-file-unreadable', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.files.failRead(`${ASSEMBLY_DIR}/manifest.json`);
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'rejected');
    assert.deepEqual(codes(outcome), ['ASSEMBLY_UNREADABLE']);
    assert.match(outcome.reasons[0]?.detail ?? '', /manifest\.json could not be read \(IO_ERROR: /);
    await assertNothingAdmitted(harness, outcome);
  });

  it('synthesized-symlink-refused', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.files.placeSpecial(`${ASSEMBLY_DIR}/linked.json`, 'symlink');
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'rejected');
    assert.equal(await failedCheck(harness), 'A12');
    assert.ok(codes(outcome).length > 0);
    await assertNothingAdmitted(harness, outcome);
  });

  for (const [name, text, shape] of [
    ['template-not-json', 'not json', 'not a JSON object'],
    ['template-not-an-object', '[]', 'not a JSON object'],
  ] as const) {
    it(name, async () => {
      const harness = await AdmissionHarness.create('RUN');
      harness.runner.scriptSynthOutput(
        synthesizedAssemblyFiles('RUN', harnessId(2)).map((file) =>
          file.path === TEMPLATE_FILE ? { ...file, bytes: new TextEncoder().encode(text) } : file,
        ),
      );
      const outcome = await harness.admit();
      assert.equal(outcome.kind, 'rejected');
      assert.deepEqual(outcome.reasons, [
        {
          code: 'TEMPLATE_UNREADABLE',
          subject: 'BR-RUA-042',
          detail: `template string "${TEMPLATE_FILE}" is ${shape}; expected the synthesized stack template`,
        },
      ]);
      await assertNothingAdmitted(harness, outcome);
    });
  }

  it('frozen-copy-unreadable', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.files.failList(FROZEN_COPY);
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'failed');
    assert.deepEqual(codes(outcome), ['ASSEMBLY_UNREADABLE']);
    assert.equal(
      await harness.packagePaths().then((paths) => paths.some((path) => path.endsWith('execution-manifest.json'))),
      false,
    );
  });

  for (const [name, prepare] of [
    [
      'frozen-copy-holds-a-special-file',
      (harness: AdmissionHarness): Promise<void> => {
        harness.files.placeSpecial(`${FROZEN_COPY}/stray.lock`, 'fifo');
        return Promise.resolve();
      },
    ],
    [
      'frozen-copy-holds-an-extra-file',
      async (harness: AdmissionHarness): Promise<void> => {
        await harness.files.createFile(`${FROZEN_COPY}/stray.txt`, new TextEncoder().encode('x'), 0o644);
      },
    ],
  ] as const) {
    it(name, async () => {
      const harness = await AdmissionHarness.create('RUN');
      await prepare(harness);
      const outcome = await harness.admit();
      assert.equal(outcome.kind, 'failed');
      assert.deepEqual(codes(outcome), ['FROZEN_ASSEMBLY_NOT_IDENTICAL']);
      assert.match(
        outcome.reasons[0]?.detail ?? '',
        /^the package copy inventories to (not inventoried|[0-9a-f]{64}); expected the staging inventory [0-9a-f]{64}$/,
      );
      const paths = await harness.packagePaths();
      assert.equal(
        paths.some((path) => path.endsWith('execution-manifest.json')),
        false,
      );
    });
  }
});
