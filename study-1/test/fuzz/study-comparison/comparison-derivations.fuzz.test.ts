// Properties of the comparison derivations over broad input spaces (design §12.5): BR-RUA-007
// equality is `pass` iff no reason, and a declared difference always shows the declared values;
// the run summary always has the four declared trials in order with verdicts copied verbatim; the
// run terminal reason is always the earliest stopping event when there is one.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import fc from 'fast-check';

import { structurallyEqual } from '../../../src/record-contract/canonical-json.ts';
import type { JsonObject, JsonValue, Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { ProjectionDifference } from '../../../src/record-contract/records/group-c/comparison_assessment.ts';
import type { ComparisonTrialInputs } from '../../../src/study-comparison/equality-sheets.ts';
import type { RunnerEvent } from '../../../src/study-comparison/run-terminal-reason.ts';
import { evaluateEquality } from '../../../src/study-comparison/equality-evaluation.ts';
import { buildRunSummary } from '../../../src/study-comparison/run-summary.ts';
import type { RunSummaryInput } from '../../../src/study-comparison/run-summary.ts';
import { deriveRunTerminalReason } from '../../../src/study-comparison/run-terminal-reason.ts';
import { parsedJson } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { cleanRunRecords } from '../../unit/study-comparison/support/clean-run.ts';
import { VISIBILITY_DIFFERENCE, slotInputs } from '../../unit/study-comparison/support/equality-inputs.ts';
import { resultsOf } from '../../unit/study-comparison/support/frozen-results.ts';
import { interruptionEvent, leaseEvent, phaseEvent } from '../../unit/study-comparison/support/runner-events.ts';

const FIELD_NAMES = ['a', 'b', 'source_visibility_timeout_ms', 'constructor', '__proto__', 'toString'] as const;
const fieldValue: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constantFrom<JsonValue>(1, 2, null, 60_000, 360_000, 'x'),
  fc.json({ maxDepth: 2 }).map(parsedJson),
);
const sheetFields: fc.Arbitrary<JsonObject> = fc
  .array(fc.tuple(fc.constantFrom(...FIELD_NAMES), fieldValue), { maxLength: 3 })
  .map((entries) => {
    const fields: Record<string, JsonValue> = {};
    for (const [name, value] of entries) {
      Object.defineProperty(fields, name, { value, enumerable: true, writable: true, configurable: true });
    }
    return fields;
  });
const slotSheet = fc.oneof(
  { arbitrary: fc.record({ common: sheetFields, within_variant: sheetFields }), weight: 9 },
  { arbitrary: fc.constant('missing' as const), weight: 1 },
);
const fourSlots = fc.tuple(slotSheet, slotSheet, slotSheet, slotSheet);

describe('equality properties (BR-RUA-007)', () => {
  it('is pass iff no reason, and every declared difference shows the declared values (property)', () => {
    fc.assert(
      fc.property(fourSlots, fc.boolean(), (slots, declare) => {
        const inputs = slotInputs({
          message_source_protocol: (slot) => {
            const sheet = slots[slot];
            return sheet === undefined || sheet === 'missing'
              ? { missing: [{ code: 'ARTIFACT_MISSING', subject: 'message_source_protocol', detail: 'absent' }] }
              : sheet;
          },
        });
        const equality = evaluateEquality(inputs, declare ? [VISIBILITY_DIFFERENCE] : []);
        assert.equal(equality.equality_result === 'pass', equality.reasons.length === 0);
        assert.equal(
          equality.equality_result,
          equality.projections.some((p) => p.result === 'fail')
            ? 'fail'
            : equality.projections.some((p) => p.result === 'indeterminate')
              ? 'indeterminate'
              : 'pass',
        );
        for (const projection of equality.projections) {
          assert.ok(projection.compared_fields.length > 0);
          projection.differences.forEach((difference) => {
            assertDifferenceShape(difference, inputs, declare);
          });
        }
        assert.deepEqual(evaluateEquality(inputs, declare ? [VISIBILITY_DIFFERENCE] : []), equality);
      }),
      fuzzParameters(),
    );
  });
});

// A difference has two distinct values at least; a declared one is the manifest's declaration, with
// each trial showing exactly its variant's declared value.
function assertDifferenceShape(
  difference: ProjectionDifference,
  inputs: readonly ComparisonTrialInputs[],
  declare: boolean,
): void {
  assert.ok(new Set(difference.values.map((entry) => JSON.stringify(entry.value))).size > 1);
  if (!difference.declared) {
    return;
  }
  assert.ok(declare && difference.field === VISIBILITY_DIFFERENCE.parameter);
  for (const entry of difference.values) {
    const trial = inputs.find((input) => input.trial_id === entry.trial_id);
    assert.ok(trial !== undefined && structurallyEqual(entry.value, VISIBILITY_DIFFERENCE[trial.variant_id]));
  }
}

let summaryInput: RunSummaryInput;

before(async () => {
  const records = await cleanRunRecords();
  const { cleanup, late_evidence: late } = records;
  assert.ok(cleanup !== undefined && late !== undefined);
  summaryInput = {
    run_id: records.run_id,
    execution_manifest_sha256: records.execution_manifest.ref.artifact_sha256,
    trials: records.execution_manifest.record.trials,
    started_trials: new Set(),
    oracle_results: resultsOf(records),
    run_terminal_reason: 'TRIAL_INCOMPLETE',
    comparison: {
      comparison_eligibility: 'ineligible',
      comparison_ineligibility_reasons: [{ code: 'C', subject: 's', detail: 'd' }],
    },
    comparison_assessment_ref: late.ref,
    cleanup,
    leak_audit_status: 'clean',
    lease_status: 'released',
    safety_status: 'within_limits',
    evidence_integrity_status: 'unverified',
    late_evidence_assessment_ref: late.ref,
    created_at: '2026-10-05T13:15:00.000Z' as UtcMillis,
  };
});

describe('run summary properties (AC-RUA-012)', () => {
  it('always reports the four declared trials in order with verdicts copied verbatim (property)', () => {
    const subset = fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean());
    fc.assert(
      fc.property(subset, subset, (frozen, started) => {
        const trials = summaryInput.trials;
        const results = new Map([...summaryInput.oracle_results].filter((_, index) => frozen[index] === true));
        const startedTrials = new Set<Uuid4>(
          trials.filter((_, index) => started[index] === true).map((trial) => trial.trial_id),
        );
        const summary = buildRunSummary({ ...summaryInput, oracle_results: results, started_trials: startedTrials });
        assert.deepEqual(
          summary.trial_results.map((entry) => entry.trial_id),
          trials.map((trial) => trial.trial_id),
        );
        summary.trial_results.forEach((entry) => {
          const result = results.get(entry.trial_id);
          if (result === undefined) {
            assert.equal(entry.execution_status, startedTrials.has(entry.trial_id) ? 'incomplete' : 'not_started');
            assert.equal(entry.incompletion_reasons.length, 1);
            return;
          }
          assert.ok('preservation_verdict' in entry);
          assert.equal(entry.preservation_verdict, result.record.preservation_verdict);
          assert.equal(entry.correct_completion, result.record.correct_completion);
        });
        assert.equal(summary.execution_status === 'completed', results.size === 4);
      }),
      fuzzParameters(),
    );
  });
});

type EventMaker = (minute: number) => RunnerEvent;

/** Events that stop the run, with the reason each gives (design §8.14 precedence). */
const STOPPING_EVENTS: readonly { readonly make: EventMaker; readonly reason: string }[] = [
  { make: (minute) => phaseEvent('PROVISIONING', 'failed', minute), reason: 'PROVISIONING_FAILED' },
  { make: (minute) => phaseEvent('LEASE_ACQUISITION', 'failed', minute), reason: 'LEASE_ACQUISITION_FAILED' },
  { make: (minute) => phaseEvent('TRIALS', 'failed', minute), reason: 'TRIAL_INCOMPLETE' },
  { make: (minute) => interruptionEvent('OPERATOR_ABORT', minute), reason: 'OPERATOR_ABORT' },
  { make: (minute) => leaseEvent('LOST_STALE', minute), reason: 'LEASE_LOST' },
];
/** Events that never stop the run. */
const QUIET_EVENTS: readonly { readonly make: EventMaker; readonly reason: undefined }[] = [
  { make: (minute) => phaseEvent('TRIALS', 'succeeded', minute), reason: undefined },
  { make: (minute) => leaseEvent('HEARTBEAT_CONFIRMED', minute), reason: undefined },
  { make: (minute) => phaseEvent('CLEANUP', 'failed', minute), reason: undefined },
  { make: (minute) => leaseEvent('RELEASE_FAILED', minute), reason: undefined },
];

describe('run terminal reason properties (CTR-RUA-002)', () => {
  it('is the earliest stopping event, whatever else happened (property)', () => {
    const drawnEvent = fc.record({
      minute: fc.nat({ max: 59 }),
      kind: fc.constantFrom(...STOPPING_EVENTS, ...QUIET_EVENTS),
    });
    fc.assert(
      fc.property(fc.array(drawnEvent, { maxLength: 8 }), fc.boolean(), (drawn, frozen) => {
        const derived = deriveRunTerminalReason({
          events: drawn.map(({ minute, kind }) => kind.make(minute)),
          all_trials_frozen: frozen,
          cleanup_status: 'succeeded',
          leak_audit_status: 'clean',
        });
        // Stable: among stopping events of the same minute, the first drawn wins.
        const earliest = drawn
          .filter(({ kind }) => kind.reason !== undefined)
          .toSorted((a, b) => a.minute - b.minute)[0];
        assert.equal(derived, earliest?.kind.reason ?? (frozen ? 'COMPLETED' : 'TRIAL_INCOMPLETE'));
      }),
      fuzzParameters(),
    );
  });
});
