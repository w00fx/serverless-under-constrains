// Probe cardinality and validity (BR-RUA-027, design §8.11). The isolated probe workload expects
// exactly one caller invocation, one accepted provider call and one committed transaction:
// - `caller_invocations` counts the distinct `caller_invocation_started` events of `probe_caller`,
//   cross-checked against the runner's `probe_workload_invoked` by Lambda request id; the larger
//   of the two counts is kept, so an invocation that never wrote its start still counts;
// - `accepted_provider_calls` counts `provider_call_accepted`;
// - `committed_transactions` is the ledger's length.
// Any count above 1 makes the probe `invalid`. A count that cannot be established (its journal or
// ledger missing, gapped or unusable, or the cross-check failing) makes it `indeterminate`. Counts of
// 0 are left to the conditions.

import type { IngestedEvidence } from '../../evidence-ingestion/ingestion-model.ts';
import type { EvidenceRef } from '../../record-contract/evidence-refs.ts';
import type { StructuredReason } from '../../record-contract/primitives.ts';
import type { ProbeCardinality } from '../../record-contract/records/group-c/transport_probe_result.ts';
import type { TrialValidity } from '../../record-contract/records/group-c/vocabulary.ts';
import { canonicalRefs } from '../../treatment-fidelity/condition-result.ts';
import { eventsOfType, partitionEvents } from '../../treatment-fidelity/subject-events.ts';
import { incompleteArtifactReason, subjectArtifactState } from '../../treatment-fidelity/subject-artifacts.ts';
import type { SubjectArtifactState } from '../../treatment-fidelity/subject-artifacts.ts';

const SUBJECT = 'BR-RUA-027';

export interface ProbeValidityAssessment {
  readonly probe_validity: TrialValidity;
  readonly cardinality: ProbeCardinality;
  readonly reasons: readonly StructuredReason[];
  readonly evidence_refs: readonly EvidenceRef[];
}

/** One count, and why it could not be established when it could not. */
interface CountJudgement {
  readonly field: keyof ProbeCardinality;
  readonly count: number;
  readonly unestablished: readonly StructuredReason[];
}

/**
 * Counts the probe workload and judges its validity.
 *
 * @example
 * assessProbeValidity(probeEvidence); // { probe_validity: 'valid', cardinality: { 1, 1, 1 }, ... }
 */
export function assessProbeValidity(evidence: IngestedEvidence): ProbeValidityAssessment {
  const caller = subjectArtifactState(evidence, 'caller_journal');
  const provider = subjectArtifactState(evidence, 'provider_journal');
  const runner = subjectArtifactState(evidence, 'runner_journal');
  const ledger = subjectArtifactState(evidence, 'ledger_snapshot');
  const invocations = invocationCount(evidence, caller, runner);
  const accepted = acceptedCallCount(evidence, provider);
  const transactions = transactionCount(evidence, ledger);
  const judgements = [invocations, accepted, transactions];
  const cardinality: ProbeCardinality = {
    caller_invocations: invocations.count,
    accepted_provider_calls: accepted.count,
    committed_transactions: transactions.count,
  };
  const exceeded = judgements.filter((judgement) => judgement.count > 1);
  const refs = canonicalRefs([caller.ref, provider.ref, runner.ref, ledger.ref].filter((ref) => ref !== undefined));
  if (exceeded.length > 0) {
    return { probe_validity: 'invalid', cardinality, reasons: exceeded.map(exceededReason), evidence_refs: refs };
  }
  const unestablished = judgements.flatMap((judgement) => judgement.unestablished);
  return {
    probe_validity: unestablished.length > 0 ? 'indeterminate' : 'valid',
    cardinality,
    reasons: unestablished,
    evidence_refs: refs,
  };
}

function invocationCount(
  evidence: IngestedEvidence,
  caller: SubjectArtifactState,
  runner: SubjectArtifactState,
): CountJudgement {
  const events = partitionEvents(evidence);
  const started = eventsOfType(events, 'caller_invocation_started').filter(
    (event) => event.record.source === 'probe_caller',
  );
  const invoked = eventsOfType(events, 'probe_workload_invoked');
  const startedIds = new Set(started.map((event) => event.record.lambda_request_id));
  const invokedIds = new Set(invoked.map((event) => event.record.lambda_request_id));
  const unestablished = [caller, runner]
    .filter((state) => !state.complete)
    .map((state) => incompleteArtifactReason(state, SUBJECT));
  const crossChecked = startedIds.size === invokedIds.size && [...startedIds].every((id) => invokedIds.has(id));
  if (!crossChecked) {
    const detail = `caller journal starts Lambda requests [${[...startedIds].join(', ')}] and the runner invoked [${[...invokedIds].join(', ')}]; expected the same request ids`;
    unestablished.push({ code: 'INVOCATION_CROSS_CHECK_FAILED', subject: SUBJECT, ...pathOf(caller), detail });
  }
  return { field: 'caller_invocations', count: Math.max(started.length, invokedIds.size), unestablished };
}

function acceptedCallCount(evidence: IngestedEvidence, provider: SubjectArtifactState): CountJudgement {
  const accepted = eventsOfType(partitionEvents(evidence), 'provider_call_accepted');
  const unestablished = provider.complete ? [] : [incompleteArtifactReason(provider, SUBJECT)];
  return { field: 'accepted_provider_calls', count: accepted.length, unestablished };
}

function transactionCount(evidence: IngestedEvidence, state: SubjectArtifactState): CountJudgement {
  const ledger = evidence.ledger;
  const usable = ledger.status === 'present' && ledger.pagination_complete;
  if (usable) {
    return { field: 'committed_transactions', count: ledger.transactions.length, unestablished: [] };
  }
  const reason =
    state.ref === undefined
      ? incompleteArtifactReason(state, SUBJECT)
      : {
          code: 'LEDGER_NOT_USABLE',
          subject: SUBJECT,
          artifact_path: state.path,
          detail: `the ledger is ${ledger.status} with pagination ${ledger.pagination_complete ? 'complete' : 'incomplete'}; expected a complete ledger to count transactions`,
        };
  return { field: 'committed_transactions', count: ledger.transactions.length, unestablished: [reason] };
}

function exceededReason(judgement: CountJudgement): StructuredReason {
  return {
    code: 'PROBE_CARDINALITY_EXCEEDED',
    subject: SUBJECT,
    detail: `${judgement.field} is ${String(judgement.count)}; expected exactly 1`,
  };
}

function pathOf(state: SubjectArtifactState): { readonly artifact_path?: string } {
  return state.ref === undefined ? {} : { artifact_path: state.path };
}
