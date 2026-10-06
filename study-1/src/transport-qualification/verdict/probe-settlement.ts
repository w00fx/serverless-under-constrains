// Settlement of the probe (BR-RUA-032, design §8.11). The probe's evidence is verified only when
// settlement under the probe policy is established. The settlement evaluator belongs to a later
// work package, so the probe reads the runner's `settlement_assessed` judgement and requires the
// frozen samples it was derived from to be present and readable; re-deriving settlement from the
// samples is not done here (evidence/WP-10/decisions.md).

import { eventRef, reasonAt } from '../../evidence-ingestion/gate-assessment.ts';
import type { GateCause } from '../../evidence-ingestion/gate-assessment.ts';
import type { IngestedEvidence } from '../../evidence-ingestion/ingestion-model.ts';
import { eventsOfType, partitionEvents } from '../../treatment-fidelity/subject-events.ts';
import { incompleteArtifactReason, subjectArtifactState } from '../../treatment-fidelity/subject-artifacts.ts';

const SUBJECT = 'BR-RUA-032';

/**
 * The causes that keep the probe's settlement from being established; none when it is.
 *
 * @example
 * probeSettlementCauses(probeEvidence); // [] when the runner established settlement
 */
export function probeSettlementCauses(evidence: IngestedEvidence): readonly GateCause[] {
  const samples = subjectArtifactState(evidence, 'settlement_samples');
  const runner = subjectArtifactState(evidence, 'runner_journal');
  const causes: GateCause[] = [];
  if (!samples.complete) {
    causes.push({
      value: 'unverified',
      reason: incompleteArtifactReason(samples, SUBJECT),
      refs: samples.ref === undefined ? [] : [samples.ref],
    });
  }
  const assessed = eventsOfType(partitionEvents(evidence), 'settlement_assessed').at(-1);
  if (assessed === undefined) {
    const reason =
      runner.ref === undefined
        ? incompleteArtifactReason(runner, SUBJECT)
        : reasonAt(
            SUBJECT,
            'SETTLEMENT_NOT_ASSESSED',
            'no settlement_assessed in the runner journal; expected the settlement judgement',
            runner.ref,
          );
    causes.push({ value: 'unverified', reason, refs: runner.ref === undefined ? [] : [runner.ref] });
    return causes;
  }
  if (assessed.record.status !== 'established') {
    const ref = eventRef(assessed);
    const detail = `settlement_assessed ${assessed.record.event_id} is ${assessed.record.status}; expected established`;
    causes.push({
      value: 'unverified',
      reason: reasonAt(SUBJECT, 'SETTLEMENT_NOT_ESTABLISHED', detail, ref),
      refs: [ref],
    });
  }
  return causes;
}
