// The monitoring a LATE_EVIDENCE amendment reassesses under (BR-RUA-043, D-16): the one the original
// assessment declares. A skipped window stays skipped, a complete window keeps both instants, a
// window that claims completion without both instants is a failed one (it cannot be shown complete),
// and a shortened or failed window keeps whichever instants it has.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { monitoringOf } from '../../../src/execution-lifecycle/late-evidence-amendment.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { LateEvidenceAssessment } from '../../../src/record-contract/records/group-c/late_evidence_assessment.ts';

const STARTED = '2026-10-05T12:30:00.000Z' as UtcMillis;
const ENDED = '2026-10-05T12:40:00.000Z' as UtcMillis;

interface DeclaredMonitoring {
  readonly monitoring: LateEvidenceAssessment['monitoring'];
  readonly monitoring_started_at?: UtcMillis;
  readonly monitoring_ended_at?: UtcMillis;
}

// Only the monitoring members are read; the rest of the record is irrelevant to the projection.
function declared(monitoring: DeclaredMonitoring): LateEvidenceAssessment {
  return monitoring as unknown as LateEvidenceAssessment;
}

describe('monitoringOf', () => {
  it('keeps a skipped window skipped, whatever instants it carries', () => {
    assert.deepEqual(monitoringOf(declared({ monitoring: 'skipped', monitoring_started_at: STARTED })), {
      outcome: 'skipped',
    });
  });

  it('keeps a complete window with both instants', () => {
    assert.deepEqual(
      monitoringOf(declared({ monitoring: 'complete', monitoring_started_at: STARTED, monitoring_ended_at: ENDED })),
      { outcome: 'complete', started_at: STARTED, ended_at: ENDED },
    );
  });

  it('reads a complete window missing an instant as failed', () => {
    assert.deepEqual(monitoringOf(declared({ monitoring: 'complete', monitoring_started_at: STARTED })), {
      outcome: 'failed',
      started_at: STARTED,
    });
    assert.deepEqual(monitoringOf(declared({ monitoring: 'complete', monitoring_ended_at: ENDED })), {
      outcome: 'failed',
      ended_at: ENDED,
    });
  });

  it('keeps a shortened or failed window with the instants it has', () => {
    assert.deepEqual(
      monitoringOf(declared({ monitoring: 'shortened', monitoring_started_at: STARTED, monitoring_ended_at: ENDED })),
      { outcome: 'shortened', started_at: STARTED, ended_at: ENDED },
    );
    assert.deepEqual(monitoringOf(declared({ monitoring: 'failed' })), { outcome: 'failed' });
  });
});
