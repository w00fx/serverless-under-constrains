// The settlement facts of one trial, read once for gates G1 and G6 (design §8.3): the runner's
// publication of the trial message (the instant the observation deadline counts from), the
// runner's `settlement_assessed`, and the BR-RUA-032 re-derivation from the frozen samples under
// the OR-RUA-002 policy. The re-derivation runs only when the samples are complete and the
// publication is known: partial samples could only disagree with the runner spuriously.

import type { IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import { evaluateSettlement } from '../settlement/evaluate-settlement.ts';
import { TRIAL_SETTLEMENT_POLICY } from '../settlement/settlement-policy.ts';
import type { SettlementAssessment } from '../settlement/settlement-policy.ts';
import { subjectArtifactState } from '../treatment-fidelity/subject-artifacts.ts';
import type { SubjectArtifactState } from '../treatment-fidelity/subject-artifacts.ts';
import { eventsOfType, partitionEvents } from '../treatment-fidelity/subject-events.ts';
import type { EventOf } from '../treatment-fidelity/subject-events.ts';

export interface TrialSettlement {
  readonly samples: SubjectArtifactState;
  readonly runner_journal: SubjectArtifactState;
  readonly published?: EventOf<'trial_message_published'>;
  readonly assessed?: EventOf<'settlement_assessed'>;
  /** Absent when the samples are incomplete or the publication is unknown. */
  readonly derived?: SettlementAssessment;
}

/**
 * Reads a trial's settlement facts and re-derives settlement from its samples.
 *
 * @example
 * readTrialSettlement(evidence).derived?.status; // 'established' for a settled trial
 */
export function readTrialSettlement(evidence: IngestedEvidence): TrialSettlement {
  const events = partitionEvents(evidence);
  const samples = subjectArtifactState(evidence, 'settlement_samples');
  const published = eventsOfType(events, 'trial_message_published').at(-1);
  const assessed = eventsOfType(events, 'settlement_assessed').at(-1);
  const base = {
    samples,
    runner_journal: subjectArtifactState(evidence, 'runner_journal'),
    ...(published === undefined ? {} : { published }),
    ...(assessed === undefined ? {} : { assessed }),
  };
  if (!samples.complete || published === undefined) {
    return base;
  }
  const records = evidence.observations.settlement_samples.map((located) => located.record);
  return { ...base, derived: evaluateSettlement(records, TRIAL_SETTLEMENT_POLICY, published.record.occurred_at) };
}
