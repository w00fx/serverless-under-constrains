// Design §12.5 for the late-evidence assessment (BR-RUA-043, D-16, Owner amendment A-05): the late
// stream is untrusted bytes, so reading it and assessing with it are total. Over arbitrary bytes,
// arbitrary JSON lines and arbitrary edits of valid late records with any monitoring outcome, the
// reader never throws and names only its closed problem codes with bounded details, and the
// assessment either refuses with reasons or returns a schema-valid record whose status agrees with
// its monitoring and reassessments, without touching a frozen result's bytes. The A-05 regressions
// (deep nesting, a number that overflows a double, inherited member names) are replayed as fixed
// inputs.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { RawArtifact } from '../../../../src/evidence-ingestion/ingestion-model.ts';
import { canonicalJson } from '../../../../src/record-contract/canonical-json.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { LateEvidenceAssessment } from '../../../../src/record-contract/records/group-c/late_evidence_assessment.ts';
import { assessLateEvidence } from '../../../../src/trial-oracle/late-evidence/assess-late-evidence.ts';
import type { LateMonitoring } from '../../../../src/trial-oracle/late-evidence/late-evidence-input.ts';
import { LATE_PROBLEM_CODES } from '../../../../src/trial-oracle/late-evidence/late-evidence-reasons.ts';
import { readLateStream } from '../../../../src/trial-oracle/late-evidence/late-stream-reading.ts';
import type { LateStreamContext } from '../../../../src/trial-oracle/late-evidence/late-stream-reading.ts';
import { projectionChanges } from '../../../../src/trial-oracle/late-evidence/projection-changes.ts';
import { verdictProjection } from '../../../../src/trial-oracle/verdict-projection.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';
import { ORACLE_VALIDATOR } from '../../../unit/trial-oracle/support/built-trials.ts';
import { CONVENTIONAL_CONTROL, CONVENTIONAL_TREATMENT } from '../../../unit/trial-oracle/support/trial-plans.ts';
import {
  COMPLETE_MONITORING,
  duplicateSignal,
  frozenFixture,
  lateInput,
  lateLedger,
  lateRecord,
  lateStreamText,
  runIdOf,
} from '../../../unit/trial-oracle/late-evidence/support/late-fixtures.ts';

const control = frozenFixture(CONVENTIONAL_CONTROL);
const treatment = frozenFixture(CONVENTIONAL_TREATMENT);
const CONTEXT: LateStreamContext = {
  execution: { run_id: runIdOf(control) },
  execution_manifest_sha256: control.result.execution_manifest_sha256,
  trial_manifests: new Map([
    [control.result.trial_id, control.result.trial_manifest_sha256],
    [treatment.result.trial_id, treatment.result.trial_manifest_sha256],
  ]),
};
const PROBLEM_CODES: ReadonlySet<string> = new Set(LATE_PROBLEM_CODES);
/** A problem detail quotes at most two bounded values around fixed text. */
const DETAIL_LIMIT = 1_000;

/** Valid late lines of both trials, before any edit. */
const LATE_LINES: readonly JsonObject[] = [
  lateRecord(control, { sequence: 1, late_source: 'LEDGER', late_record: lateLedger(control, 1) }),
  lateRecord(control, { sequence: 1, late_source: 'LEDGER', late_record: lateLedger(control, 0) }),
  lateRecord(treatment, { sequence: 1, late_source: 'CONTROLLER_JOURNAL', late_record: duplicateSignal(treatment) }),
  lateRecord(treatment, { sequence: 1, late_source: 'LEDGER', late_record: lateLedger(treatment, 1) }),
  lateRecord(control, {
    sequence: 1,
    late_source: 'RUNNER_JOURNAL',
    late_record: { schema_version: 1, record_type: 'phase_transition_recorded' },
    correlated: false,
    trial_scoped: false,
  }),
];
const MEMBERS = [...new Set(LATE_LINES.flatMap((line) => Object.keys(line)))];

/** One stream line: a valid late line, optionally with one member replaced or removed. */
const lineArbitrary = fc.record({
  base: fc.nat({ max: LATE_LINES.length - 1 }),
  edit: fc.option(
    fc.record({
      member: fc.constantFrom(...MEMBERS, 'constructor', '__proto__'),
      value: fc.option(fc.jsonValue().map((value) => value as JsonValue)),
    }),
    { freq: 3 },
  ),
});

const monitoringArbitrary: fc.Arbitrary<LateMonitoring> = fc.oneof(
  fc.constant(COMPLETE_MONITORING),
  fc.constant<LateMonitoring>({ outcome: 'skipped' }),
  fc.constantFrom<'shortened' | 'failed'>('shortened', 'failed').map((outcome): LateMonitoring => ({ outcome })),
);

function editedLine(
  base: number,
  edit: { readonly member: string; readonly value: JsonValue | null } | null,
  sequence: number,
): string {
  const kept = Object.entries({ ...LATE_LINES[base], sequence }).filter(([member]) => member !== edit?.member);
  const line = Object.fromEntries(kept) as Record<string, JsonValue>;
  if (edit !== null && edit.value !== null) {
    // defineProperty, so a `__proto__` edit becomes an own member, as JSON.parse would make it.
    Object.defineProperty(line, edit.member, {
      value: edit.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return canonicalJson(line);
}

// The record with one member replaced (or removed when the value is null), defined as an own
// member so `__proto__` behaves as JSON.parse makes it.
function withMember(record: JsonObject, member: string, value: JsonValue | null): JsonObject {
  const kept = Object.fromEntries(Object.entries(record).filter(([name]) => name !== member));
  if (value !== null) {
    Object.defineProperty(kept, member, { value, enumerable: true, writable: true, configurable: true });
  }
  return kept;
}

function streamOf(lines: readonly string[], closed: boolean): RawArtifact {
  const text = lines.join('\n');
  return lateStreamText(closed && text !== '' ? `${text}\n` : text);
}

function assertReading(stream: RawArtifact): void {
  const reading = readLateStream(stream, CONTEXT, ORACLE_VALIDATOR);
  for (const problem of reading.problems) {
    assert.ok(PROBLEM_CODES.has(problem.code), problem.code);
    assert.ok(problem.detail.length <= DETAIL_LIMIT, `${String(problem.detail.length)} characters`);
  }
  for (const accepted of reading.accepted) {
    assert.equal(accepted.record.sequence, accepted.line_number);
    assert.equal(accepted.record.correlated, true);
  }
}

function assertAssessmentConsistent(assessment: LateEvidenceAssessment): void {
  const valid = ORACLE_VALIDATOR.validateAs('late_evidence_assessment', assessment as unknown as JsonValue);
  assert.ok(valid.valid, JSON.stringify(valid.valid ? [] : valid.violations));
  const statuses = assessment.reassessments.map((reassessment) => reassessment.status);
  assert.equal(assessment.late_evidence_status === 'unverified', assessment.monitoring !== 'complete');
  if (assessment.late_evidence_status === 'none') {
    assert.equal(assessment.correlated_record_count, 0);
  }
  if (assessment.monitoring === 'complete') {
    assert.equal(assessment.late_evidence_status === 'contradictory', statuses.includes('contradictory'));
  }
}

describe('late-evidence reading and assessment over untrusted streams', () => {
  it('reads arbitrary bytes totally, with closed codes and bounded details', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        assertReading({ path: 'late-evidence/late-evidence-stream.jsonl', bytes });
      }),
      fuzzParameters(),
    );
  });

  it('reads arbitrary JSON lines totally', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue({ maxDepth: 4 }), { maxLength: 6 }), fc.boolean(), (values, closed) => {
        assertReading(
          streamOf(
            values.map((value) => JSON.stringify(value)),
            closed,
          ),
        );
      }),
      fuzzParameters(),
    );
  });

  it('assesses edited late records under any monitoring totally, never touching frozen bytes', () => {
    const frozenBytes = [control.evidence.result.bytes.slice(), treatment.evidence.result.bytes.slice()];
    fc.assert(
      fc.property(
        fc.array(lineArbitrary, { maxLength: 4 }),
        fc.boolean(),
        fc.option(fc.nat({ max: 3 }), { freq: 4 }),
        monitoringArbitrary,
        (lines, closed, sequenceShift, monitoring) => {
          const text = lines.map((line, index) => editedLine(line.base, line.edit, index + 1 + (sequenceShift ?? 0)));
          const assessment = assessLateEvidence(
            lateInput([control, treatment], streamOf(text, closed), monitoring),
            ORACLE_VALIDATOR,
          );
          if (assessment.ok) {
            assertAssessmentConsistent(assessment.value);
          } else {
            assert.ok(assessment.error.length > 0, 'a refusal names its reasons');
          }
          assert.deepEqual([control.evidence.result.bytes, treatment.evidence.result.bytes], frozenBytes);
        },
      ),
      fuzzParameters(),
    );
  });

  it('never accepts a carried record that fails its own schema', () => {
    const carriedLines = LATE_LINES.filter((line) => line['correlated'] === true);
    const carriedMembers = [
      ...new Set(carriedLines.flatMap((line) => Object.keys(line['late_record'] as JsonObject))),
      'constructor',
      '__proto__',
    ];
    fc.assert(
      fc.property(
        fc.nat({ max: carriedLines.length - 1 }),
        fc.constantFrom(...carriedMembers),
        fc.option(fc.jsonValue({ maxDepth: 3 }).map((value) => value as JsonValue)),
        (base, member, value) => {
          const line = carriedLines[base] ?? {};
          const carried = withMember(line['late_record'] as JsonObject, member, value);
          const stream = lateStreamText(`${canonicalJson({ ...line, sequence: 1, late_record: carried })}\n`);
          const reading = readLateStream(stream, CONTEXT, ORACLE_VALIDATOR);
          if (!ORACLE_VALIDATOR.validate(carried).valid) {
            assert.deepEqual(reading.accepted, []);
            assert.equal(reading.problems.length, 1);
          }
        },
      ),
      fuzzParameters(),
    );
  });

  it('finds no change in an unchanged projection and every change on both sides', () => {
    const projections = [verdictProjection(control.result), verdictProjection(treatment.result)] as const;
    fc.assert(
      fc.property(fc.constantFrom(0, 1), fc.constantFrom(0, 1), (a: 0 | 1, b: 0 | 1) => {
        const [left, right] = [projections[a], projections[b]];
        const forward = projectionChanges(left, right);
        const backward = projectionChanges(right, left);
        assert.deepEqual(
          backward,
          forward.map((change) => ({ field: change.field, frozen: change.reassessed, reassessed: change.frozen })),
        );
        assert.equal(forward.length === 0, a === b);
        assert.ok(forward.every((change) => change.frozen !== change.reassessed));
      }),
      fuzzParameters(),
    );
  });
});

describe('late-evidence A-05 regressions (fixed inputs)', () => {
  it('reads a 100,000-level nested line and a deep carried record without throwing', () => {
    const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    assertReading(lateStreamText(`${deep}\n`));
    const carried = JSON.stringify(LATE_LINES[2]).replace('"late_record":{', `"late_record":{"deep":${deep},`);
    const assessment = assessLateEvidence(
      lateInput([control, treatment], lateStreamText(`${carried}\n`)),
      ORACLE_VALIDATOR,
    );
    assert.ok(assessment.ok || assessment.error.length > 0);
  });

  it('reports a number that overflows a double as unreadable', () => {
    const reading = readLateStream(lateStreamText('{"sequence":1e400}\n'), CONTEXT, ORACLE_VALIDATOR);
    assert.deepEqual(
      reading.problems.map((problem) => problem.code),
      ['LATE_RECORD_UNREADABLE'],
    );
    assert.match(reading.problems[0]?.detail ?? '', /overflows a finite double/);
  });

  it('never reads an inherited member name as a member', () => {
    const inherited = { ...LATE_LINES[0], late_record: { ...(LATE_LINES[0]?.['late_record'] as JsonObject) } };
    const withoutRun = Object.fromEntries(Object.entries(inherited).filter(([member]) => member !== 'run_id'));
    const text = JSON.stringify(withoutRun).replace('{', '{"__proto__":{"run_id":"x"},"constructor":"y",');
    const reading = readLateStream(lateStreamText(`${text}\n`), CONTEXT, ORACLE_VALIDATOR);
    assert.deepEqual(
      reading.problems.map((problem) => problem.code),
      ['LATE_RECORD_SCHEMA_INVALID'],
    );
  });
});
