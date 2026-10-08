// Where a correlated late record belongs in the frozen evidence (BR-RUA-043, design §7 layout,
// §8.13 "ingests the frozen artifacts plus the late stream"). A journal event or queue observation
// is one more line of the stream file its source writes; a ledger snapshot, DLQ snapshot or Durable
// execution listing re-captured after freeze contributes its items to the frozen document. The
// runner journal and the A-09 execution-level provider partition are execution-level files, which
// every trial's evidence holds. A record with no place here cannot be folded into any evaluation.

import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../evidence-package/package-layout.ts';
import type { UNIT_PATHS } from '../../evidence-package/package-layout.ts';
import { isEventRecordType, isRecordType } from '../../record-contract/record-types.ts';
import type { RecordType } from '../../record-contract/record-types.ts';
import type { Uuid4 } from '../../record-contract/primitives.ts';
import type { LateEvidenceRecord } from '../../record-contract/records/group-c/late_evidence_record.ts';
import type { LateEvidenceSource } from '../../record-contract/records/group-c/vocabulary.ts';

/** How a late record joins the frozen file at its route's path. */
export type LateFold = 'append_line' | 'ledger_transactions' | 'dlq_messages' | 'durable_executions';

/** The frozen file a late record joins and how. */
export interface LateRoute {
  readonly path: string;
  readonly fold: LateFold;
  /** True for an execution-level file, which the frozen evidence of every trial holds. */
  readonly shared: boolean;
}

/** A record kind a route accepts: any journal event, or one record type. */
type AcceptedRecord = 'event' | RecordType;

interface ExecutionRoute {
  readonly source: LateEvidenceSource;
  readonly accepts: AcceptedRecord;
  readonly path: string;
}

interface TrialRoute {
  readonly source: LateEvidenceSource;
  readonly accepts: AcceptedRecord;
  readonly fold: LateFold;
  /** A file of the trial's directory, or an execution-level path. */
  readonly place: { readonly unit: keyof typeof UNIT_PATHS } | { readonly execution: string };
}

/** Records that name no trial: only execution-level journals can hold them. */
const EXECUTION_ROUTES: readonly ExecutionRoute[] = [
  { source: 'RUNNER_JOURNAL', accepts: 'event', path: EXECUTION_PATHS.runnerJournal },
  { source: 'PROVIDER_JOURNAL', accepts: 'event', path: EXECUTION_PATHS.executionProviderJournal },
];

/** Records that name a trial. Runner events of a trial still live in the one runner journal. */
const TRIAL_ROUTES: readonly TrialRoute[] = [
  { source: 'CALLER_JOURNAL', accepts: 'event', fold: 'append_line', place: { unit: 'callerJournal' } },
  { source: 'PROVIDER_JOURNAL', accepts: 'event', fold: 'append_line', place: { unit: 'providerJournal' } },
  { source: 'CONTROLLER_JOURNAL', accepts: 'event', fold: 'append_line', place: { unit: 'controllerJournal' } },
  {
    source: 'RUNNER_JOURNAL',
    accepts: 'event',
    fold: 'append_line',
    place: { execution: EXECUTION_PATHS.runnerJournal },
  },
  { source: 'LEDGER', accepts: 'ledger_snapshot', fold: 'ledger_transactions', place: { unit: 'ledgerSnapshot' } },
  {
    source: 'SOURCE_QUEUE',
    accepts: 'queue_observation',
    fold: 'append_line',
    place: { unit: 'sourceObservations' },
  },
  { source: 'DLQ', accepts: 'queue_observation', fold: 'append_line', place: { unit: 'dlqObservations' } },
  { source: 'DLQ', accepts: 'dlq_snapshot', fold: 'dlq_messages', place: { unit: 'dlqSnapshot' } },
  {
    source: 'DURABLE_EXECUTION_METADATA',
    accepts: 'durable_execution_metadata',
    fold: 'durable_executions',
    place: { unit: 'durableExecutions' },
  },
];

/**
 * The route of a late record, or undefined when its source, record type and scope have no place
 * in the frozen evidence.
 *
 * @example
 * routeLateRecord(lateCommitConfirmed);
 * // { path: 'trials/<trial_id>/journals/provider-journal.jsonl', fold: 'append_line', shared: false }
 */
export function routeLateRecord(record: LateEvidenceRecord): LateRoute | undefined {
  const trialId = record.trial_id;
  if (trialId === undefined) {
    const route = EXECUTION_ROUTES.find((candidate) => matches(candidate, record));
    return route === undefined ? undefined : { path: route.path, fold: 'append_line', shared: true };
  }
  const route = TRIAL_ROUTES.find((candidate) => matches(candidate, record));
  return route === undefined ? undefined : placeOf(route, trialId);
}

function matches(route: ExecutionRoute | TrialRoute, record: LateEvidenceRecord): boolean {
  const type = record.late_record_type;
  if (route.source !== record.late_source || !isRecordType(type)) {
    return false;
  }
  return route.accepts === 'event' ? isEventRecordType(type) : route.accepts === type;
}

function placeOf(route: TrialRoute, trialId: Uuid4): LateRoute {
  const place = route.place;
  return 'unit' in place
    ? {
        path: PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trialId }, place.unit),
        fold: route.fold,
        shared: false,
      }
    : { path: place.execution, fold: route.fold, shared: true };
}
