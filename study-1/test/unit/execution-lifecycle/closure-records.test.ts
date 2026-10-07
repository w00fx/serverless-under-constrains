// The closure records a probe or validation summary cites: read only when they are valid records of
// this execution's manifest, every unreadable file, unreadable journal line and foreign record
// reported and left out; the runner's P9 safety checks kept apart from its phase and interruption
// events; the summary inputs that are missing named by path; and the runner and coordination
// journals merged in time order, keeping the given order within one instant.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  inJournalTime,
  missingSummaryInputs,
  readClosureRecords,
} from '../../../src/execution-lifecycle/closure-records.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { interruptionEvent, leaseEvent, phaseEvent } from '../study-comparison/support/runner-events.ts';
import { safetyEvent } from '../variant-validation/support/lifecycle-events.ts';

const deps = { validator: createRecordValidator(), digest: sha256Hex };
const OWN = leaseEvent('ACQUIRED', 1).execution_manifest_sha256;
const OTHER = 'e'.repeat(64) as Sha256Hex;

function jsonl(...lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(lines.map((line) => `${line}\n`).join(''));
}

describe('readClosureRecords', () => {
  it('keeps the events of this manifest and reports unreadable and foreign ones', () => {
    const files = new Map([
      [
        EXECUTION_PATHS.runnerJournal,
        jsonl(
          JSON.stringify(phaseEvent('TRIALS', 'succeeded', 3)),
          JSON.stringify({ ...interruptionEvent('OPERATOR_ABORT', 4), execution_manifest_sha256: OTHER }),
          '{not json',
        ),
      ],
      [
        EXECUTION_PATHS.coordinationJournal,
        jsonl(
          JSON.stringify(leaseEvent('ACQUIRED', 1)),
          JSON.stringify({ ...leaseEvent('RELEASED', 9), execution_manifest_sha256: OTHER }),
        ),
      ],
      [EXECUTION_PATHS.cleanupResult, new TextEncoder().encode('not json\n')],
    ]);
    const closure = readClosureRecords(files, OWN, deps);
    assert.deepEqual(
      closure.runner_events.map((event) => event.record_type),
      ['phase_transition_recorded'],
    );
    assert.deepEqual(
      closure.lease_events.map((event) => event.lease_event),
      ['ACQUIRED'],
    );
    assert.equal(closure.cleanup, undefined);
    assert.equal(closure.leak_audit, undefined);
    assert.equal(closure.safety, undefined);
    assert.equal(closure.late_evidence, undefined);
    const paths = closure.reasons.map((reason) => reason.artifact_path);
    // Journal lines first (read before the records), then records, then foreign events.
    assert.deepEqual(paths, [
      EXECUTION_PATHS.runnerJournal,
      EXECUTION_PATHS.cleanupResult,
      EXECUTION_PATHS.runnerJournal,
      EXECUTION_PATHS.coordinationJournal,
    ]);
    const foreign = closure.reasons.filter((reason) =>
      reason.detail.includes(`names execution_manifest_sha256 ${OTHER}`),
    );
    assert.equal(foreign.length, 2);
    assert.match(foreign[0]?.detail ?? '', new RegExp(`expected ${OWN}$`));
    assert.ok(foreign.every((reason) => reason.code === 'ARTIFACT_UNREADABLE' && reason.subject === 'BR-RUA-033'));
  });

  it('reads the safety checks of this manifest apart from the phase and interruption events', () => {
    const breached = { ...safetyEvent('TOTAL_TIME', 'breached'), execution_manifest_sha256: OWN };
    const foreign = { ...safetyEvent('ESTIMATED_COST', 'breached'), execution_manifest_sha256: OTHER };
    const files = new Map([
      [
        EXECUTION_PATHS.runnerJournal,
        jsonl(
          JSON.stringify(phaseEvent('SUMMARY', 'started', 30)),
          JSON.stringify(breached),
          JSON.stringify(foreign),
          JSON.stringify({ ...breached, result: 'breached', observed: undefined }),
        ),
      ],
    ]);
    const closure = readClosureRecords(files, OWN, deps);
    assert.deepEqual(closure.safety_checks, [breached]);
    assert.deepEqual(
      closure.runner_events.map((event) => event.record_type),
      ['phase_transition_recorded'],
    );
    assert.deepEqual(
      closure.reasons.map((reason) => reason.code),
      ['ARTIFACT_UNREADABLE', 'ARTIFACT_UNREADABLE'],
      'a conclusive check without its observed value is unreadable, and a foreign one is reported',
    );
    assert.match(closure.reasons[0]?.detail ?? '', /line 4: .*expected a valid safety_check_recorded/);
  });

  it('reads an empty package as no record and no event', () => {
    const closure = readClosureRecords(new Map(), OWN, deps);
    assert.deepEqual(closure.runner_events, []);
    assert.deepEqual(closure.safety_checks, []);
    assert.deepEqual(closure.lease_events, []);
    assert.deepEqual(closure.reasons, []);
  });
});

describe('missingSummaryInputs', () => {
  it('names each required input that is absent, in the order required', () => {
    const closure = readClosureRecords(new Map(), OWN, deps);
    const reasons = missingSummaryInputs(closure, ['safety', 'cleanup', 'late_evidence']);
    assert.deepEqual(
      reasons.map((reason) => [reason.code, reason.subject, reason.artifact_path]),
      [
        ['SUMMARY_INPUT_MISSING', 'BR-RUA-044', EXECUTION_PATHS.safetyAssessment],
        ['SUMMARY_INPUT_MISSING', 'BR-RUA-044', EXECUTION_PATHS.cleanupResult],
        ['SUMMARY_INPUT_MISSING', 'BR-RUA-044', EXECUTION_PATHS.lateEvidenceAssessment],
      ],
    );
    assert.equal(
      reasons[0]?.detail,
      `${EXECUTION_PATHS.safetyAssessment} is absent or unreadable; expected it frozen before the summary`,
    );
    assert.deepEqual(missingSummaryInputs(closure, []), []);
  });
});

describe('inJournalTime', () => {
  it('orders by instant and keeps the given order within one instant', () => {
    const late = phaseEvent('SUMMARY', 'failed', 30);
    const first = leaseEvent('LOST_STALE', 9);
    const second = interruptionEvent('OPERATOR_ABORT', 9);
    const early = phaseEvent('READINESS', 'failed', 2);
    assert.deepEqual(inJournalTime([late, first, second, early]), [early, first, second, late]);
    assert.deepEqual(inJournalTime([second, first]), [second, first]);
  });
});
