// Late-record capture (BR-RUA-043; design §8.13, §10.4 step 1; AC-RUA-030). After late monitoring,
// cleanup step 1 completes the cutoff: the collector re-reads every source each frozen unit was
// collected from and keeps only what the frozen artifacts do not hold, compared by identity
// (`late-record-identity.ts`). The result is the dense `late-evidence/late-evidence-stream.jsonl`
// that the late-evidence assessment reads (WP-15 `readLateStream`, `routeLateRecord`).
//
// For each unit (a trial or the probe), in plan order:
// - the caller journal and the experiment journal (provider and controller sources) of its
//   partition, one late record per new event;
// - the ledger, a strongly consistent paged read, one LEDGER record when a transaction is new;
// - for a queued trial, the DLQ received without deletion and correlated by the same rule as at
//   freeze (MessageGroupId = trial id, AC-RUA-020), one DLQ record when a message is new;
// - for a Durable trial, the execution listing, one record when an execution new to the trial's
//   listing window is listed (`durableListingWindow`: the listing has no trial filter).
// A re-captured document is carried as read, restricted to its new items: its frozen items are
// already evidence, and repeating them with values that changed since (a DLQ message's receive
// count, an execution's status) would add a second copy of a frozen record.
// Then the execution-level partitions (D-10 canary, addendum §2 warm-up, A-09 provider) are re-read
// the same way. Only the A-09 provider journal correlates: its records are evidence of the
// execution that the late-evidence routing folds into every trial (`EXECUTION_ROUTES`). The canary
// and warm-up records are readiness evidence that is never a verdict input (addendum §2 item 2,
// decision 56), so they are kept in the stream uncorrelated.
//
// A read that fails, a frozen copy that is missing or unreadable, or a record that cannot be
// carried makes the whole capture fail with every reason: it is never turned into an empty stream,
// which would claim that nothing was observed.

import { pushEach } from '../durable-store/push-each.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import { boundedText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  ExecutionIdentity,
  JsonObject,
  JsonValue,
  Result,
  Sha256Hex,
  StructuredReason,
  UtcMillis,
  WallClock,
} from '../record-contract/primitives.ts';
import type { LateEvidenceSource } from '../record-contract/records/group-c/vocabulary.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { capturePartitionKey, correlationFields, executionPartitionKey, isTrialScope } from './capture-scope.ts';
import type { CaptureScope, CaptureUnit, TrialCaptureScope } from './capture-scope.ts';
import { encodeRecordLines } from './collected-records.ts';
import type { CollectorStoreReader } from './collected-records.ts';
import type { CollectedFileKey } from './collection-buffer.ts';
import { captureDlq } from './dlq-capture.ts';
import type { DlqReceiver } from './dlq-capture.ts';
import { collectDurableExecutionMetadata } from './durable-metadata.ts';
import type { DurableExecutionReader, DurableListingRequest } from './durable-metadata.ts';
import { exportJournals, unitJournalPlans } from './journal-export.ts';
import type { CollectedJournalFile, JournalExportPlan } from './journal-export.ts';
import { captureLedgerSnapshot } from './ledger-capture.ts';
import { absentItems, documentItems, DOCUMENT_ITEM_MEMBERS, frozenIdentities } from './late-record-identity.ts';
import type { DocumentItemKind, LateItemKind } from './late-record-identity.ts';
import type { QueueTarget } from './queue-observation.ts';
import { EXECUTION_JOURNAL_PARTITIONS } from './readiness-collection.ts';
import { ownValue } from './sdk-values.ts';

/** The exact frozen bytes of a unit's or the execution's artifacts, by layout key. */
export type FrozenArtifacts = Readonly<Partial<Record<CollectedFileKey, Uint8Array>>>;

/** One frozen unit: what it was collected from, and the artifacts it froze. */
export interface LateCaptureUnit {
  readonly unit: CaptureUnit;
  /** The variant's DLQ of a queued trial; absent for the probe. */
  readonly dlq?: QueueTarget;
  /** The caller version's listing of a Durable trial, as at freeze. */
  readonly durable?: DurableListingRequest;
  readonly frozen: FrozenArtifacts;
}

/** Every frozen unit of one execution, and the execution-level artifacts as packaged. */
export interface LateCapturePlan {
  readonly execution: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly units: readonly LateCaptureUnit[];
  readonly execution_frozen: FrozenArtifacts;
}

/** The production readers the capture uses; no new SDK client (design §5.3). */
export interface LateCapturePorts {
  readonly store: CollectorStoreReader;
  readonly dlq: DlqReceiver;
  readonly durable: DurableExecutionReader;
  readonly clock: WallClock;
}

/** The captured late stream: its `late_evidence_record` lines and their JSONL bytes. */
export interface LateRecordStream {
  readonly records: readonly JsonObject[];
  readonly bytes: Uint8Array;
}

/** Where one late record was observed and whom it correlates with. */
interface LateObservation {
  /** The execution identity, manifest digest and, for a trial, the trial pair. */
  readonly correlation: JsonObject;
  readonly late_source: LateEvidenceSource;
  readonly correlated: boolean;
  readonly captured_at: string;
  readonly late_record_type: string;
  readonly record: JsonObject;
}

interface CaptureState {
  readonly observations: LateObservation[];
  readonly failures: StructuredReason[];
}

/** How one re-read relates to the frozen copy it is compared with. */
interface ReadContext {
  readonly correlation: JsonObject;
  readonly correlated: boolean;
  readonly frozen: FrozenArtifacts;
  /** A unit or execution label for reason details. */
  readonly owner: string;
}

const JOURNAL_LATE_SOURCES: Readonly<Record<CollectedJournalFile, LateEvidenceSource>> = {
  callerJournal: 'CALLER_JOURNAL',
  providerJournal: 'PROVIDER_JOURNAL',
  controllerJournal: 'CONTROLLER_JOURNAL',
  canaryCallerJournal: 'CALLER_JOURNAL',
  canaryControllerJournal: 'CONTROLLER_JOURNAL',
  warmupProviderJournal: 'PROVIDER_JOURNAL',
  executionProviderJournal: 'PROVIDER_JOURNAL',
};

// The record_type_name shape of the late_evidence_record schema (`_defs` record_type_name).
const RECORD_TYPE_NAME = /^[a-z][a-z0-9_]*$/;
const SUBJECT = 'BR-RUA-043';

/**
 * Re-reads every frozen unit and the execution-level partitions and returns the late stream: the
 * records absent from the frozen artifacts as dense `late_evidence_record` lines, or every reason
 * the capture could not be completed.
 *
 * @example
 * const stream = await captureLateRecords({ store, dlq, durable, clock }, plan);
 * if (stream.ok) await pkg.writeOnce('late-evidence/late-evidence-stream.jsonl', stream.value.bytes);
 */
export async function captureLateRecords(
  ports: LateCapturePorts,
  plan: LateCapturePlan,
): Promise<Result<LateRecordStream, readonly StructuredReason[]>> {
  const state: CaptureState = { observations: [], failures: [] };
  for (const unit of plan.units) {
    await captureUnit(ports, plan, unit, state);
  }
  await captureExecutionPartitions(ports, plan, state);
  if (state.failures.length > 0) {
    return err(state.failures);
  }
  const records = state.observations.map((observation, index) => lateEvidenceLine(observation, index + 1));
  const bytes = encodeRecordLines(records, 'late_evidence_stream');
  return bytes.ok ? ok({ records, bytes: bytes.value }) : err([bytes.error]);
}

async function captureUnit(
  ports: LateCapturePorts,
  plan: LateCapturePlan,
  unit: LateCaptureUnit,
  state: CaptureState,
): Promise<void> {
  const scope: CaptureScope = {
    execution: plan.execution,
    execution_manifest_sha256: plan.execution_manifest_sha256,
    unit: unit.unit,
  };
  const context: ReadContext = {
    correlation: correlationFields(scope),
    correlated: true,
    frozen: unit.frozen,
    owner: capturePartitionKey(scope),
  };
  for (const journalPlan of unitJournalPlans(capturePartitionKey(scope))) {
    await captureJournal(ports, journalPlan, context, state);
  }
  const ledger = await captureLedgerSnapshot(ports.store, scope, ports.clock);
  pushEach(state.failures, ledger.failures);
  keepDocument(state, context, { kind: 'ledger_transaction', key: 'ledgerSnapshot', source: 'LEDGER' }, ledger.record);
  if (isTrialScope(scope)) {
    await captureQueuedEvidence(ports, plan.units, unit, scope, context, state);
  }
}

// DLQ and Durable evidence exist only for trials (design §7: the probe has no queues).
async function captureQueuedEvidence(
  ports: LateCapturePorts,
  units: readonly LateCaptureUnit[],
  unit: LateCaptureUnit,
  scope: TrialCaptureScope,
  context: ReadContext,
  state: CaptureState,
): Promise<void> {
  if (unit.dlq !== undefined) {
    const dlq = await captureDlq(ports.dlq, unit.dlq, scope, ports.clock);
    pushEach(state.failures, dlq.failures);
    keepDocument(
      state,
      context,
      { kind: 'dlq_message', key: 'dlqSnapshot', source: 'DLQ', conditional: true },
      dlq.record,
    );
  }
  if (unit.durable !== undefined) {
    const metadata = await collectDurableExecutionMetadata(ports.durable, unit.durable, scope, ports.clock);
    pushEach(state.failures, metadata.failures);
    const window = durableListingWindow(units, unit.durable);
    const document = {
      kind: 'durable_execution',
      key: 'durableExecutions',
      source: 'DURABLE_EXECUTION_METADATA',
      within: (execution: JsonValue) => startsWithin(execution, window),
    } as const;
    keepDocument(state, context, document, metadata.record);
  }
}

/** The start instants of one Durable trial's executions: from its publication to the next one's. */
interface DurableWindow {
  readonly from: UtcMillis;
  /** The next publication of the same caller alias in the plan; undefined for the last trial. */
  readonly until: UtcMillis | undefined;
}

// CMP-03 review F3. The listing has no trial filter (`durable-metadata.ts`): every Durable trial of
// an execution lists the same caller function and alias from its own publication on, so re-listing
// an earlier trial also returns every later trial's executions, which that trial never froze. The
// trials run one after another (spec: "The canonical run contains exactly four sequential trials"),
// so an execution belongs to the one trial whose window holds its start: from the trial's
// publication up to the next publication of the same alias, the window its freeze read.
function durableListingWindow(units: readonly LateCaptureUnit[], request: DurableListingRequest): DurableWindow {
  const later = units.flatMap((other) =>
    other.durable !== undefined && publishedLater(other.durable, request) ? [other.durable.started_after] : [],
  );
  return { from: request.started_after, until: later.sort()[0] };
}

function publishedLater(other: DurableListingRequest, request: DurableListingRequest): boolean {
  return (
    other.function_arn === request.function_arn &&
    other.qualifier === request.qualifier &&
    other.started_after > request.started_after
  );
}

// UtcMillis instants have one fixed-width form, so they order as strings. An execution without a
// start instant cannot be placed in a window and is kept: nothing shows it is another trial's.
function startsWithin(execution: JsonValue, window: DurableWindow): boolean {
  const startedAt = ownValue(execution, 'started_at');
  return (
    typeof startedAt !== 'string' ||
    (startedAt >= window.from && (window.until === undefined || startedAt < window.until))
  );
}

async function captureExecutionPartitions(
  ports: LateCapturePorts,
  plan: LateCapturePlan,
  state: CaptureState,
): Promise<void> {
  const correlation: JsonObject = {
    ...executionIdentityFields(plan.execution),
    execution_manifest_sha256: plan.execution_manifest_sha256,
  };
  for (const partition of EXECUTION_JOURNAL_PARTITIONS) {
    const partitionKey = executionPartitionKey(plan.execution, plan.execution_manifest_sha256, partition.kind);
    const context: ReadContext = {
      correlation,
      correlated: partition.kind === 'provider',
      frozen: plan.execution_frozen,
      owner: partitionKey,
    };
    const journalPlan = { table: partition.table, partition_key: partitionKey, routes: [partition.route] };
    await captureJournal(ports, journalPlan, context, state);
  }
}

async function captureJournal(
  ports: LateCapturePorts,
  plan: JournalExportPlan,
  context: ReadContext,
  state: CaptureState,
): Promise<void> {
  const exported = await exportJournals(ports.store, plan);
  if (!exported.ok) {
    state.failures.push(exported.error);
    return;
  }
  const capturedAt = formatUtcMillis(ports.clock.now());
  for (const file of exported.value) {
    const late = lateAgainstFrozen('journal_event', context, file.file, file.events, false);
    keepEvents(state, context, JOURNAL_LATE_SOURCES[file.file], capturedAt, late);
  }
}

function keepEvents(
  state: CaptureState,
  context: ReadContext,
  source: LateEvidenceSource,
  capturedAt: string,
  late: Result<readonly JsonObject[], StructuredReason>,
): void {
  if (!late.ok) {
    state.failures.push(late.error);
    return;
  }
  for (const event of late.value) {
    keepObservation(state, context, source, capturedAt, event);
  }
}

/** A re-captured document: the kind of its items, its layout key and its late source. */
interface DocumentRead {
  readonly kind: DocumentItemKind;
  readonly key: CollectedFileKey;
  readonly source: LateEvidenceSource;
  /** True when its absence at freeze means no item was frozen (the conditional DLQ snapshot). */
  readonly conditional?: boolean;
  /** Which new items belong to the unit; all of them when absent. */
  readonly within?: (item: JsonValue) => boolean;
}

// The document is carried as read, restricted to the items the frozen copy lacks; nothing new adds nothing.
function keepDocument(state: CaptureState, context: ReadContext, read: DocumentRead, document: JsonObject): void {
  const items = documentItems(read.kind, document);
  const late = lateAgainstFrozen(read.kind, context, read.key, items, read.conditional === true);
  if (!late.ok) {
    state.failures.push(late.error);
    return;
  }
  const kept = read.within === undefined ? late.value : late.value.filter(read.within);
  if (kept.length === 0) {
    return;
  }
  const capturedAt = ownValue(document, 'captured_at');
  const restricted = { ...document, [DOCUMENT_ITEM_MEMBERS[read.kind]]: [...kept] };
  keepObservation(state, context, read.source, String(capturedAt), restricted);
}

// The re-read items absent from the frozen copy; a missing copy is an empty one only for a
// conditional artifact, since otherwise nothing proves which records were frozen.
function lateAgainstFrozen<T extends JsonValue>(
  kind: LateItemKind,
  context: ReadContext,
  key: CollectedFileKey,
  items: readonly T[],
  conditional: boolean,
): Result<readonly T[], StructuredReason> {
  const frozen = context.frozen[key];
  if (frozen === undefined) {
    return conditional ? ok(absentItems(kind, new Set(), items)) : err(baselineMissing(context, key));
  }
  const known = frozenIdentities(kind, frozen);
  return known.ok ? ok(absentItems(kind, known.value, items)) : err(baselineUnreadable(context, key, known.error));
}

function keepObservation(
  state: CaptureState,
  context: ReadContext,
  source: LateEvidenceSource,
  capturedAt: string,
  record: JsonObject,
): void {
  const recordType = carriedRecordType(record);
  if (!recordType.ok) {
    state.failures.push(uncarriable(context, source, recordType.error));
    return;
  }
  state.observations.push({
    correlation: context.correlation,
    late_source: source,
    correlated: context.correlated,
    captured_at: capturedAt,
    late_record_type: recordType.value,
    record,
  });
}

// A carried record must name its type the way late_record_type does, and carry its version
// (late_evidence_record schema: late_record requires schema_version and record_type).
function carriedRecordType(record: JsonObject): Result<string, string> {
  const recordType = ownValue(record, 'record_type');
  if (typeof recordType !== 'string') {
    return err('no string record_type');
  }
  if (!RECORD_TYPE_NAME.test(recordType)) {
    return err(`record_type "${boundedText(recordType)}"`);
  }
  return Object.hasOwn(record, 'schema_version')
    ? ok(recordType)
    : err(`record_type "${boundedText(recordType)}" but no schema_version`);
}

function lateEvidenceLine(observation: LateObservation, sequence: number): JsonObject {
  return {
    schema_version: 1,
    record_type: 'late_evidence_record',
    ...observation.correlation,
    sequence,
    captured_at: observation.captured_at,
    late_source: observation.late_source,
    correlated: observation.correlated,
    late_record_type: observation.late_record_type,
    late_record: observation.record,
  };
}

function baselineMissing(context: ReadContext, key: CollectedFileKey): StructuredReason {
  return {
    code: 'LATE_BASELINE_MISSING',
    subject: SUBJECT,
    detail: `${key} of ${boundedText(context.owner)} has no frozen copy; expected the frozen artifact the re-read is compared with`,
  };
}

function baselineUnreadable(context: ReadContext, key: CollectedFileKey, why: string): StructuredReason {
  return {
    code: 'LATE_BASELINE_UNREADABLE',
    subject: SUBJECT,
    detail: `the frozen ${key} of ${boundedText(context.owner)} ${why}; expected the frozen artifact as the collector wrote it`,
  };
}

function uncarriable(context: ReadContext, source: LateEvidenceSource, problem: string): StructuredReason {
  return {
    code: 'LATE_RECORD_MALFORMED',
    subject: SUBJECT,
    detail: `a new ${source} record of ${boundedText(context.owner)} has ${problem}; expected a record with schema_version and a lowercase snake record_type`,
  };
}
