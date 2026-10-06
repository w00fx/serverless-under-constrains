// A-05 / AC-RUA-046 feed: reading a run package back for comparison, summary and completion is total
// over untrusted bytes. Every record file and journal read returns a value for any bytes; a package
// with one read file replaced by arbitrary bytes or arbitrary JSON is either refused (only through
// its execution manifest) or read with reasons, and finalizing what was read never throws and only
// produces schema-valid records. Permanent regressions: 100,000-level nesting, non-finite numbers,
// and member names inherited from Object.prototype.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import fc from 'fast-check';

import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { readJournalRecords, readRecordFile } from '../../../src/study-comparison/record-files.ts';
import type { StudyComparisonRecordType } from '../../../src/study-comparison/record-files.ts';
import { finalizeRunAssessments } from '../../../src/study-comparison/run-package-assessment.ts';
import { readRunPackage } from '../../../src/study-comparison/run-package-reader.ts';
import type { FixtureBytes } from '../../support/golden-builder/digest-links.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { specDeploymentProjection } from '../../golden/study-comparison/support/golden-run.ts';
import { READ_DEPS, cleanRunFiles, trialFile, withBytes } from '../../unit/study-comparison/support/clean-run.ts';

const encoder = new TextEncoder();
const validator = createRecordValidator();
const RECORD_TYPES: readonly StudyComparisonRecordType[] = [
  'execution_manifest',
  'resource_manifest',
  'trial_manifest',
  'provider_trial_configuration',
  'source_provenance',
  'oracle_result',
  'late_evidence_assessment',
  'cleanup_result',
  'leak_audit_result',
  'safety_assessment',
  'comparison_assessment',
  'run_summary',
];
const JOURNAL_TYPES = ['phase_transition_recorded', 'trial_interrupted', 'lease_event_recorded'] as const;
const INHERITED_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'] as const;

let files: FixtureBytes;
let readPaths: readonly string[];

before(async () => {
  files = await cleanRunFiles();
  const clean = readRunPackage(files, READ_DEPS);
  assert.ok(clean.ok);
  const trialPaths = clean.value.trial_records.flatMap(({ trial }) =>
    (['trialManifest', 'providerTrialConfiguration', 'payment', 'approvedDecision', 'oracleResult'] as const).map(
      (file) => trialFile(trial.trial_id, file),
    ),
  );
  readPaths = [
    EXECUTION_PATHS.executionManifest,
    EXECUTION_PATHS.resourceManifest,
    EXECUTION_PATHS.sourceProvenance,
    EXECUTION_PATHS.lateEvidenceAssessment,
    EXECUTION_PATHS.cleanupResult,
    EXECUTION_PATHS.leakAuditResult,
    EXECUTION_PATHS.safetyAssessment,
    EXECUTION_PATHS.comparisonAssessment,
    EXECUTION_PATHS.runSummary,
    EXECUTION_PATHS.runnerJournal,
    EXECUTION_PATHS.coordinationJournal,
    ...trialPaths,
  ];
});

// Reading and finalizing a package never throws; a refusal names the execution manifest, and a
// finalized package only holds schema-valid records.
function assertTotal(packageFiles: FixtureBytes): void {
  const read = readRunPackage(packageFiles, READ_DEPS);
  if (!read.ok) {
    assert.ok(read.error.length > 0);
    assert.ok(read.error.every((reason) => reason.artifact_path === EXECUTION_PATHS.executionManifest));
    return;
  }
  assert.ok(read.value.reasons.every((reason) => reason.code === 'ARTIFACT_UNREADABLE'));
  const finalized = finalizeRunAssessments(
    read.value,
    {
      deployment: specDeploymentProjection(read.value.execution_manifest.ref.artifact_sha256),
      contradictory_amendments: [],
      finalized_at: '2026-10-05T13:15:00.000Z' as UtcMillis,
    },
    sha256Hex,
  );
  if (finalized.ok) {
    assert.ok(
      validator.validateAs('comparison_assessment', finalized.value.comparison_assessment.record as never).valid,
    );
    assert.ok(validator.validateAs('run_summary', finalized.value.run_summary.record as never).valid);
  }
}

describe('study-comparison reading is total (A-05, AC-RUA-046)', () => {
  it('readRecordFile returns a value for any bytes of any record type (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...RECORD_TYPES), fc.uint8Array({ maxLength: 256 }), (recordType, bytes) => {
        const read = readRecordFile(new Map([['x.json', bytes]]), 'x.json', recordType, READ_DEPS);
        assert.ok(
          read.status === 'read' || (read.status === 'unreadable' && read.reason.code === 'ARTIFACT_UNREADABLE'),
        );
      }),
      fuzzParameters(),
    );
  });

  it('readRecordFile returns a value for any JSON text of any record type (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...RECORD_TYPES), fc.json({ maxDepth: 4 }), (recordType, text) => {
        const read = readRecordFile(new Map([['x.json', encoder.encode(text)]]), 'x.json', recordType, READ_DEPS);
        assert.notEqual(read.status, 'absent');
      }),
      fuzzParameters(),
    );
  });

  it('readJournalRecords keeps only valid records of the requested types (property)', () => {
    const lines = fc.oneof(
      fc.json({ maxDepth: 3 }),
      fc
        .record({ record_type: fc.constantFrom<string>(...JOURNAL_TYPES, ...INHERITED_NAMES) })
        .map((value) => JSON.stringify(value)),
      fc.string(),
    );
    fc.assert(
      fc.property(fc.array(lines, { maxLength: 8 }), fc.subarray([...JOURNAL_TYPES]), (journal, requested) => {
        const bytes = encoder.encode(journal.map((line) => `${line}\n`).join(''));
        const read = readJournalRecords(new Map([['j.jsonl', bytes]]), 'j.jsonl', requested, READ_DEPS);
        assert.ok(read.records.every((record) => (requested as readonly string[]).includes(record.record_type)));
        assert.ok(read.reasons.every((reason) => reason.code === 'ARTIFACT_UNREADABLE'));
      }),
      fuzzParameters(),
    );
  });

  it('a package with one read file replaced by arbitrary bytes is read or refused, never thrown (property)', () => {
    fc.assert(
      fc.property(fc.nat(), fc.uint8Array({ maxLength: 128 }), (index, bytes) => {
        assertTotal(withBytes(files, readPaths[index % readPaths.length] ?? '', bytes));
      }),
      fuzzParameters(),
    );
  });

  it('a package with one read file replaced by arbitrary JSON is read or refused, never thrown (property)', () => {
    fc.assert(
      fc.property(fc.nat(), fc.json({ maxDepth: 4 }), (index, text) => {
        assertTotal(withBytes(files, readPaths[index % readPaths.length] ?? '', encoder.encode(text)));
      }),
      fuzzParameters(),
    );
  });

  it('a package with one flipped byte in a read file is read or refused, never thrown (property)', () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), fc.integer({ min: 1, max: 255 }), (index, offset, mask) => {
        const path = readPaths[index % readPaths.length] ?? '';
        const stored = files.get(path) ?? new Uint8Array(1);
        const mutated = stored.slice();
        const at = offset % mutated.length;
        mutated[at] = (mutated[at] ?? 0) ^ mask;
        assertTotal(withBytes(files, path, mutated));
      }),
      fuzzParameters(),
    );
  });
});

describe('study-comparison reading regressions (A-05)', () => {
  it('reads 100,000-level nesting in every record file as unreadable, never throwing', () => {
    for (const shape of ['array', 'object', 'mixed'] as const) {
      const tower = encoder.encode(towerText(shape, DEEP_NESTING, '1'));
      for (const path of [
        EXECUTION_PATHS.cleanupResult,
        EXECUTION_PATHS.executionManifest,
        EXECUTION_PATHS.runnerJournal,
      ]) {
        assertTotal(withBytes(files, path, tower));
      }
      const read = readRecordFile(new Map([['x.json', tower]]), 'x.json', 'run_summary', READ_DEPS);
      assert.equal(read.status, 'unreadable');
    }
  });

  it('reads a deeply nested member inside a record as unreadable', () => {
    const text = new TextDecoder().decode(files.get(EXECUTION_PATHS.cleanupResult));
    const deep = text.replace('"resources":[]', `"resources":[${towerText('object', DEEP_NESTING, '1')}]`);
    assert.notEqual(deep, text);
    const read = readRecordFile(new Map([['x.json', encoder.encode(deep)]]), 'x.json', 'cleanup_result', READ_DEPS);
    assert.equal(read.status, 'unreadable');
    assertTotal(withBytes(files, EXECUTION_PATHS.cleanupResult, encoder.encode(deep)));
  });

  it('reads non-finite numbers as unreadable records and journal lines', () => {
    for (const number of ['1e400', '-1e400', 'NaN', 'Infinity']) {
      const text = new TextDecoder()
        .decode(files.get(EXECUTION_PATHS.safetyAssessment))
        .replace('"schema_version":1', `"schema_version":${number}`);
      assert.ok(text.includes(`"schema_version":${number}`));
      const read = readRecordFile(
        new Map([['x.json', encoder.encode(text)]]),
        'x.json',
        'safety_assessment',
        READ_DEPS,
      );
      assert.equal(read.status, 'unreadable', number);
      const journal = readJournalRecords(
        new Map([['j.jsonl', encoder.encode(`{"record_type":"trial_interrupted","source_sequence":${number}}\n`)]]),
        'j.jsonl',
        ['trial_interrupted'],
        READ_DEPS,
      );
      assert.deepEqual(journal.records, []);
      assert.equal(journal.reasons.length, 1, number);
    }
  });

  it('never reads a member inherited from Object.prototype as a record type or member', () => {
    for (const name of INHERITED_NAMES) {
      const journal = readJournalRecords(
        new Map([['j.jsonl', encoder.encode(`{"${name}":"phase_transition_recorded"}\n{"record_type":"${name}"}\n`)]]),
        'j.jsonl',
        ['phase_transition_recorded'],
        READ_DEPS,
      );
      assert.deepEqual(journal, { records: [], reasons: [] }, name);
      const record = readRecordFile(
        new Map([['x.json', encoder.encode(`{"${name}":{"record_type":"run_summary"}}`)]]),
        'x.json',
        'run_summary',
        READ_DEPS,
      );
      assert.equal(record.status, 'unreadable', name);
    }
  });
});
