// Reading records back from exact package bytes is total (Owner amendment A-05): absent files,
// bytes that are not UTF-8 JSON, schema-invalid documents, 100,000-deep nesting, non-finite numbers
// and inherited member names are each a bounded problem text, never a throw. An execution-level
// assessment is this validation's only when it names this validation and its manifest.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { readOwnValidationRecord, readValidationRecord } from '../../../src/variant-validation/validation-records.ts';
import type { ValidationRecordOwner } from '../../../src/variant-validation/validation-records.ts';
import { FIXTURE_VALIDATOR } from '../../support/evidence-package/probe-package-fixtures.ts';
import { utf8 } from '../../support/evidence-package/package-files.ts';
import { RUN_ID, digest, uuid } from '../../support/record-contract/record-builders.ts';
import { withoutFile } from '../../golden/variant-validation/support/golden-files.ts';
import { validationPackage } from '../../golden/variant-validation/support/validation-package.ts';
import { GOLDEN_VALIDATION_ID } from '../../golden/variant-validation/support/validation-records.ts';
import { editRecord, recordAt } from './support/package-edits.ts';
import type { RecordMembers } from './support/package-edits.ts';

const PATH = 'summary/validation-summary.json';

function read(bytes: Uint8Array): ReturnType<typeof readValidationRecord<'validation_summary'>> {
  const files: readonly PackageFile[] = [{ path: PATH, bytes }];
  return readValidationRecord(files, PATH, 'validation_summary', FIXTURE_VALIDATOR);
}

function problem(bytes: Uint8Array): string {
  const result = read(bytes);
  assert.equal(result.ok, false);
  return result.error;
}

describe('readValidationRecord', () => {
  it('returns the record and its exact stored bytes', () => {
    const fixture = validationPackage();
    const stored = fixture.files.find((file) => file.path === PATH);
    assert.ok(stored);
    const result = readValidationRecord(fixture.files, PATH, 'validation_summary', FIXTURE_VALIDATOR);
    assert.ok(result.ok);
    assert.equal(result.value.bytes, stored.bytes);
    assert.equal(result.value.record.implementation_validation_status, 'verified');
  });

  it('names an absent file and the expected record type', () => {
    const result = readValidationRecord([], PATH, 'validation_summary', FIXTURE_VALIDATOR);
    assert.deepEqual(result, { ok: false, error: `${PATH} is absent; expected a validation_summary record` });
  });

  it('names the byte offset of invalid UTF-8', () => {
    assert.match(
      problem(Uint8Array.of(0x7b, 0xff)),
      /\(invalid UTF-8 at byte 1\); expected a validation_summary record/,
    );
  });

  it('names a JSON syntax failure', () => {
    assert.match(problem(utf8('{"a":')), /is not one JSON document \(.+\); expected a validation_summary record/);
  });

  it('names the first schema violation and the violation count', () => {
    assert.match(
      problem(utf8('{}')),
      /has \d+ schema violation\(s\), first \S+ at ".*"; expected a valid validation_summary record/,
    );
  });

  it('rejects 100,000-deep nesting without throwing (A-05)', () => {
    const depth = 100_000;
    assert.match(
      problem(utf8(`${'['.repeat(depth)}${']'.repeat(depth)}`)),
      /expected a valid validation_summary record/,
    );
    assert.match(
      problem(utf8(`${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`)),
      /expected a valid validation_summary record/,
    );
    assert.match(problem(utf8('['.repeat(depth))), /is not one JSON document/);
  });

  it('rejects non-finite numbers without throwing (A-05)', () => {
    assert.equal(read(utf8('{"schema_version":1e400}')).ok, false);
    assert.equal(read(utf8('{"schema_version":-1e400}')).ok, false);
    assert.equal(read(utf8('[NaN]')).ok, false);
  });

  it('rejects inherited member names as data, never as the prototype (A-05)', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const text = `{"schema_version":1,"record_type":"validation_summary","${name}":{"polluted":true}}`;
      assert.match(problem(utf8(text)), /schema violation/);
    }
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });

  it('bounds an enormous offending member name in the problem text', () => {
    const name = 'x'.repeat(1_000_000);
    const text = problem(utf8(`{"${name}":1}`));
    assert.ok(text.length < 2_000, `problem text is ${String(text.length)} characters; expected it bounded`);
  });
});

describe('readOwnValidationRecord', () => {
  const fixture = validationPackage();
  const owner: ValidationRecordOwner = {
    variant_validation_id: GOLDEN_VALIDATION_ID,
    execution_manifest_sha256: fixture.manifest_sha256,
  };
  const late = EXECUTION_PATHS.lateEvidenceAssessment;

  function readLate(
    edit: (members: RecordMembers) => RecordMembers,
  ): ReturnType<typeof readOwnValidationRecord<'late_evidence_assessment'>> {
    return readOwnValidationRecord(
      editRecord(fixture.files, late, edit),
      late,
      'late_evidence_assessment',
      owner,
      FIXTURE_VALIDATOR,
    );
  }

  it("returns the assessment of this validation under this validation's manifest", () => {
    const safety = readOwnValidationRecord(
      fixture.files,
      EXECUTION_PATHS.safetyAssessment,
      'safety_assessment',
      owner,
      FIXTURE_VALIDATOR,
    );
    assert.deepEqual(safety, { ok: true, value: recordAt(fixture.files, EXECUTION_PATHS.safetyAssessment) });
    const lateRead = readLate((members) => members);
    assert.ok(lateRead.ok && lateRead.value.late_evidence_status === 'none');
  });

  it('passes an unreadable assessment on as the read problem', () => {
    const absent = readOwnValidationRecord(
      withoutFile(fixture.files, late),
      late,
      'late_evidence_assessment',
      owner,
      FIXTURE_VALIDATOR,
    );
    assert.deepEqual(absent, { ok: false, error: `${late} is absent; expected a late_evidence_assessment record` });
  });

  it('rejects the assessment of another validation, naming both identities', () => {
    const other = uuid(0x1799);
    assert.deepEqual(
      readLate((members) => ({ ...members, variant_validation_id: other })),
      {
        ok: false,
        error: `${late} belongs to validation ${other} under manifest ${fixture.manifest_sha256}; expected validation ${GOLDEN_VALIDATION_ID} under manifest ${fixture.manifest_sha256}`,
      },
    );
  });

  it("rejects this validation's assessment under another manifest", () => {
    const otherManifest = digest('another execution manifest');
    assert.deepEqual(
      readLate((members) => ({ ...members, execution_manifest_sha256: otherManifest })),
      {
        ok: false,
        error: `${late} belongs to validation ${GOLDEN_VALIDATION_ID} under manifest ${otherManifest}; expected validation ${GOLDEN_VALIDATION_ID} under manifest ${fixture.manifest_sha256}`,
      },
    );
  });

  it('rejects a run-scoped assessment as another execution kind', () => {
    const runScoped = readLate(({ variant_validation_id: _id, ...members }) => ({ ...members, run_id: RUN_ID }));
    assert.ok(!runScoped.ok);
    assert.match(runScoped.error, /belongs to validation none \(another execution kind\) under manifest /);
  });
});
