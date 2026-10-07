// `rua run verify` over the committed AC-RUA-027 golden run stored in the evidence root (BR-RUA-054,
// design §8.14): a complete study exits 0 with both outputs written; a selection that does not
// qualify leaves the study incomplete (exit 5) naming the mismatch; malformed selection flags are
// usage errors; a run package that cannot be read writes only its package verification.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PackageFileSystem } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { RunVerifyCommand } from '../../../src/operator-cli/run-verify-command.ts';
import type { Sha256Hex, UtcMillis } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { loadGoldenCase } from '../../golden/_harness/golden-harness.ts';
import { finalizeGoldenRun, sealGoldenRun } from '../../golden/study-comparison/support/golden-run.ts';
import { BASE_QUALIFICATION, RUN_ID } from '../../golden/study-comparison/support/run-fixture.ts';
import type { MemoryPackageFileSystem } from '../../support/evidence-package/memory-package-file-system.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { HARNESS_NOW, runCli } from './support/cli-harness.ts';
import type { CliRun } from './support/cli-harness.ts';
import { ScriptedQualificationReader } from './support/scripted-qualification-reader.ts';
import { STORED_EVIDENCE_ROOT, packageOperand, storePackage } from './support/stored-packages.ts';

const validator = createRecordValidator();
const clock = new VirtualTimeScheduler({ wallEpochMs: Date.parse(HARNESS_NOW) });
const RUN_IDENTITY = { execution_kind: 'RUN', run_id: RUN_ID } as const;
const SELECTION = [
  '--probe',
  BASE_QUALIFICATION.qualification.transport_probe_id,
  '--probe-index',
  BASE_QUALIFICATION.qualification.original_package_index_sha256,
];
const REFUSED = { code: 'SELECTION_MISMATCH', subject: 'BR-RUA-028', detail: 'scripted; expected the selection' };

async function storedRun(drop?: string): Promise<MemoryPackageFileSystem> {
  const loaded = await loadGoldenCase('test/golden/study-comparison/cases/ac027-four-cell-completion.case.ts');
  const sealed = sealGoldenRun(finalizeGoldenRun(loaded.files).files);
  return storePackage(
    RUN_IDENTITY,
    [...sealed.files].filter(([path]) => path !== drop).map(([path, bytes]) => ({ path, bytes })),
  );
}

async function verifyRun(
  fs: MemoryPackageFileSystem,
  reader: ScriptedQualificationReader,
  flags: readonly string[] = SELECTION,
): Promise<CliRun> {
  const command = new RunVerifyCommand({
    files: (): PackageFileSystem => fs,
    validator,
    clock,
    qualifications: reader,
  });
  return runCli(
    ['run', 'verify', packageOperand(RUN_IDENTITY), ...flags, '--evidence-root', STORED_EVIDENCE_ROOT],
    [command],
  );
}

function outputPath(kind: 'package-verification' | 'study-completion-assessment'): string {
  return PACKAGE_LAYOUT.verificationPath(RUN_IDENTITY, HARNESS_NOW as UtcMillis, kind);
}

describe('run verify', () => {
  it('completes the AC-RUA-027 four-cell run with the selected qualification', async () => {
    const fs = await storedRun();
    const reader = new ScriptedQualificationReader(BASE_QUALIFICATION.transport_scope_snapshot_sha256);
    const run = await verifyRun(fs, reader);
    assert.equal(run.exit_code, 0, JSON.stringify(run.result.reasons));
    assert.equal(run.result.run_id, RUN_ID);
    assert.equal(run.result.result_record?.['study_completion'], 'complete');
    assert.deepEqual(run.result.written_paths, [
      outputPath('package-verification'),
      outputPath('study-completion-assessment'),
    ]);
    assert.deepEqual(reader.selections, [{ ...BASE_QUALIFICATION.qualification, amendment_head_sha256: null }]);
  });

  it('passes an explicit probe head to the qualification reader', async () => {
    const fs = await storedRun();
    const reader = new ScriptedQualificationReader(BASE_QUALIFICATION.transport_scope_snapshot_sha256);
    const head = 'a'.repeat(64) as Sha256Hex;
    const run = await verifyRun(fs, reader, [...SELECTION, '--probe-head', head]);
    assert.equal(reader.selections[0]?.amendment_head_sha256, head);
    assert.equal(run.exit_code, 5);
    assert.ok(run.result.reasons.some((reason) => reason.code === 'QUALIFICATION_MISMATCH'));
  });

  it('leaves the study incomplete when the selection does not qualify, with both reasons', async () => {
    const fs = await storedRun();
    const run = await verifyRun(fs, new ScriptedQualificationReader(undefined, [REFUSED]));
    assert.equal(run.exit_code, 5);
    assert.equal(run.result.result_record?.['study_completion'], 'incomplete');
    const codes = run.result.reasons.map((reason) => reason.code);
    assert.ok(codes.includes('QUALIFICATION_MISMATCH'));
    assert.equal(codes.at(-1), 'SELECTION_MISMATCH');
    assert.equal(run.result.written_paths.length, 2);
  });

  it('refuses malformed selection flags as usage errors', async () => {
    const fs = await storedRun();
    const reader = new ScriptedQualificationReader();
    const malformed: readonly (readonly [readonly string[], RegExp])[] = [
      [['--probe', 'probe-1', '--probe-index', 'a'.repeat(64)], /^--probe "probe-1" is not a probe id/],
      [[SELECTION[0] ?? '', SELECTION[1] ?? '', '--probe-index', 'xyz'], /^--probe-index "xyz" is not a digest/],
      [[...SELECTION, '--probe-head', 'xyz'], /^--probe-head "xyz" is not a digest/],
    ];
    for (const [flags, detail] of malformed) {
      const run = await verifyRun(fs, reader, flags);
      assert.equal(run.exit_code, 2);
      assert.match(run.result.reasons[0]?.detail ?? '', detail);
    }
    assert.deepEqual(reader.selections, []);
  });

  it('writes only the package verification when the run package cannot be read', async () => {
    const fs = await storedRun(EXECUTION_PATHS.executionManifest);
    const run = await verifyRun(fs, new ScriptedQualificationReader('b'.repeat(64) as Sha256Hex));
    assert.equal(run.exit_code, 5);
    assert.deepEqual(run.result.written_paths, [outputPath('package-verification')]);
    assert.equal(run.result.result_record?.['record_type'], 'package_verification');
    assert.equal(run.result.result_record['package_eligibility'], 'ineligible');
  });

  it('refuses a package operand that is not a run package', async () => {
    const fs = await storedRun();
    const reader = new ScriptedQualificationReader();
    const command = new RunVerifyCommand({
      files: (): PackageFileSystem => fs,
      validator,
      clock,
      qualifications: reader,
    });
    const probeOperand = `${STORED_EVIDENCE_ROOT}/transport-probes/${RUN_ID}`;
    const run = await runCli(
      ['run', 'verify', probeOperand, ...SELECTION, '--evidence-root', STORED_EVIDENCE_ROOT],
      [command],
    );
    assert.equal(run.exit_code, 2);
    assert.deepEqual(reader.selections, []);
  });
});
