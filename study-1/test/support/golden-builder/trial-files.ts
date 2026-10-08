// The primary evidence of one trial directory (design §7), collected in the per-trial write order:
// once settlement is assessed, the collector captures the ledger and the conditional DLQ snapshot,
// exports the journals, then the treatment and configuration state (BR-RUA-043, D-32). Derived
// files (attempt projection, oracle result, evidence index) are the oracle's output and never part
// of a golden fixture.

import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import type { FixtureFileContent } from './digest-links.ts';
import { linkMd5, linkSha256, linkText } from './digest-links.ts';
import { compareCodeUnits, recordText, sortedJournal } from './golden-event-log.ts';
import { FINANCIAL_FIXTURE, GOLDEN_CALLER_VERSION, GOLDEN_TIMING, instantAt } from './golden-values.ts';
import { countersJson } from './settlement-simulation.ts';
import type { SettlementOutcome } from './settlement-simulation.ts';
import { RECEIVE_DELAY_MS, durableFunctionArn, messageIdOf } from './trial-simulation.ts';
import type { SimulatedTrial } from './trial-simulation.ts';
import {
  RESOURCE_MANIFEST_PATH,
  SLOT_OFFSETS,
  executionCorrelation,
  publishedMs,
  queueName,
  trialCorrelation,
  trialPath,
} from './trial-context.ts';
import type { TrialContext } from './trial-context.ts';
import type { DurableExecutionFact } from './trial-timeline.ts';

/** Collection instants after the settlement capture instant (established_at, or the deadline). */
export const CAPTURE_OFFSETS = {
  ledger: 2000,
  journals: 2200,
  treatment: 2500,
  telemetry: 3000,
  durable_metadata: 3500,
} as const;

/** What one trial directory is built from. */
export interface TrialEvidence {
  readonly context: TrialContext;
  readonly trial: SimulatedTrial;
  readonly settlement: SettlementOutcome;
  /** Position of the trial in the declared order (BR-RUA-019); the probe has none. */
  readonly sequence: number;
  /** The registry version of the variant's item when this trial was registered. */
  readonly registry_version: number;
}

type FileMap = Map<string, FixtureFileContent>;

/**
 * Every primary file of one trial (or of the probe directory), keyed by package-relative path.
 *
 * @example
 * trialFiles(evidence).get(`trials/${trialId}/ledger/ledger-snapshot.json`);
 */
export function trialFiles(evidence: TrialEvidence): ReadonlyMap<string, FixtureFileContent> {
  const files: FileMap = new Map();
  const put = (relative: string, record: JsonValue): void => {
    files.set(trialPath(evidence.context, relative), { kind: 'json', record });
  };
  const putLines = (relative: string, records: readonly JsonValue[]): void => {
    files.set(trialPath(evidence.context, relative), { kind: 'jsonl', records });
  };
  addInputs(evidence, put);
  addState(evidence, put);
  addJournals(evidence, putLines);
  put('ledger/ledger-snapshot.json', ledgerSnapshot(evidence));
  addQueues(evidence, put, putLines);
  putLines(
    'settlement/settlement-samples.jsonl',
    evidence.settlement.samples.map((sample) => ({ ...sample.fields, ...trialCorrelation(evidence.context) })),
  );
  if (evidence.context.caller === 'durable') {
    put('execution-metadata/durable-executions.json', durableMetadata(evidence));
  }
  put('telemetry/telemetry-availability.json', telemetry(evidence));
  return files;
}

type PutJson = (relative: string, record: JsonValue) => void;
type PutLines = (relative: string, records: readonly JsonValue[]) => void;

function addInputs(evidence: TrialEvidence, put: PutJson): void {
  const { context } = evidence;
  put('inputs/payment.json', {
    schema_version: 1,
    record_type: 'payment',
    payment_id: FINANCIAL_FIXTURE.payment_id,
    captured_amount_minor: FINANCIAL_FIXTURE.captured_amount_minor,
    currency: FINANCIAL_FIXTURE.currency,
  });
  put('inputs/approved-decision.json', {
    schema_version: 1,
    record_type: 'approved_decision',
    refund_request_id: FINANCIAL_FIXTURE.refund_request_id,
    payment_id: FINANCIAL_FIXTURE.payment_id,
    decision: FINANCIAL_FIXTURE.decision,
    approved_amount_minor: FINANCIAL_FIXTURE.approved_amount_minor,
    currency: FINANCIAL_FIXTURE.currency,
  });
  if (context.trial === undefined) {
    return;
  }
  put('trial-manifest.json', {
    schema_version: 1,
    record_type: 'trial_manifest',
    ...executionCorrelation(context.execution),
    resource_manifest_sha256: linkSha256(RESOURCE_MANIFEST_PATH),
    trial_id: context.trial.trial_id,
    sequence: evidence.sequence,
    variant_id: context.caller,
    scenario: context.scenario,
    payment_sha256: linkSha256(trialPath(context, 'inputs/payment.json')),
    approved_decision_sha256: linkSha256(trialPath(context, 'inputs/approved-decision.json')),
    frozen_at: instantAt(context.slot_ms + SLOT_OFFSETS.trial_manifest_frozen),
  });
  put('inputs/published-message.json', {
    schema_version: 1,
    record_type: 'trial_message',
    ...context.execution.identity,
    ...context.trial,
    payment_id: FINANCIAL_FIXTURE.payment_id,
    refund_request_id: FINANCIAL_FIXTURE.refund_request_id,
  });
}

function addState(evidence: TrialEvidence, put: PutJson): void {
  const { context } = evidence;
  put('state/provider-trial-configuration.json', {
    schema_version: 1,
    record_type: 'provider_trial_configuration',
    ...trialCorrelation(context),
    registered_caller_id: context.caller,
    scenario: context.caller === 'probe' ? 'COMMIT_THEN_TIMEOUT' : context.scenario,
    payment_id: FINANCIAL_FIXTURE.payment_id,
    safety_release_ms: GOLDEN_TIMING.provider_safety_release_ms,
    treatment_poll_interval_ms: GOLDEN_TIMING.treatment_poll_interval_ms,
    written_at: instantAt(context.slot_ms + SLOT_OFFSETS.configuration_written),
  });
  const capturedMs = evidence.settlement.capture_ms + CAPTURE_OFFSETS.treatment;
  const treatment = evidence.trial.timeline.treatmentAt(capturedMs);
  put('state/treatment-state-snapshot.json', {
    schema_version: 1,
    record_type: 'treatment_state_snapshot',
    ...trialCorrelation(context),
    partition_key: context.partition_key,
    captured_at: instantAt(capturedMs),
    consistent_read: true,
    ...(treatment === undefined ? { item_present: false } : { item_present: true, treatment: treatment.item }),
  });
  if (context.trial === undefined) {
    return;
  }
  put('state/trial-registration.json', {
    schema_version: 1,
    record_type: 'trial_registration',
    ...trialCorrelation(context),
    variant_id: context.caller,
    registry_version: evidence.registry_version,
    registered_at: instantAt(context.slot_ms + SLOT_OFFSETS.registration_written),
  });
}

function addJournals(evidence: TrialEvidence, putLines: PutLines): void {
  const exportedMs = evidence.settlement.capture_ms + CAPTURE_OFFSETS.journals;
  const exported = evidence.trial.log.events().filter((event) => event.at_ms <= exportedMs);
  const ofSources = (sources: readonly string[]): readonly JsonObject[] =>
    sortedJournal(exported.filter((event) => sources.includes(recordText(event.record, 'source'))));
  putLines('journals/caller-journal.jsonl', ofSources(['conventional_caller', 'durable_caller', 'probe_caller']));
  putLines('journals/provider-journal.jsonl', ofSources(['refund_provider']));
  putLines('journals/controller-journal.jsonl', ofSources(['treatment_controller']));
}

// One Query page sorted by `tx#<provider_transaction_id>` (design §9.3), read consistently.
function ledgerSnapshot(evidence: TrialEvidence): JsonObject {
  const capturedMs = evidence.settlement.capture_ms + CAPTURE_OFFSETS.ledger;
  const transactions = evidence.trial.timeline
    .ledgerAt(capturedMs)
    .map((fact) => fact.transaction)
    .toSorted((a, b) =>
      compareCodeUnits(recordText(a, 'provider_transaction_id'), recordText(b, 'provider_transaction_id')),
    );
  return {
    schema_version: 1,
    record_type: 'ledger_snapshot',
    ...trialCorrelation(evidence.context),
    writer: 'evidence_collector',
    partition_key: evidence.context.partition_key,
    consistent_read: true,
    captured_at: instantAt(capturedMs),
    complete: true,
    pages: [{ page_number: 1, item_count: transactions.length }],
    transactions,
  };
}

function addQueues(evidence: TrialEvidence, put: PutJson, putLines: PutLines): void {
  const { context } = evidence;
  if (context.caller === 'probe') {
    return;
  }
  const timeline = evidence.trial.timeline;
  const observation = (role: 'source' | 'dlq', atMs: number): JsonObject => ({
    schema_version: 1,
    record_type: 'queue_observation',
    ...trialCorrelation(context),
    queue_role: role,
    queue_name: queueName(context.execution, context.caller, role),
    observed_at: instantAt(atMs),
    read_status: 'ok',
    counters: countersJson(role === 'source' ? timeline.sourceCountersAt(atMs) : timeline.dlqCountersAt(atMs)),
  });
  const times = evidence.settlement.samples.map((sample) => sample.observed_at_ms);
  putLines(
    'queues/source-observations.jsonl',
    times.map((atMs) => observation('source', atMs)),
  );
  putLines(
    'queues/dlq-observations.jsonl',
    times.map((atMs) => observation('dlq', atMs)),
  );
  const capturedMs = evidence.settlement.dlq_captured_ms;
  if (capturedMs !== undefined) {
    put('queues/dlq-snapshot.json', dlqSnapshot(evidence, capturedMs));
  }
}

// The redriven trial message, received without delete: its exact body is the published-message
// file, and SQS reports the body digests over those bytes.
function dlqSnapshot(evidence: TrialEvidence, capturedMs: number): JsonObject {
  const { context } = evidence;
  const published = publishedMs(context);
  const message = trialPath(context, 'inputs/published-message.json');
  return {
    schema_version: 1,
    record_type: 'dlq_snapshot',
    ...trialCorrelation(context),
    queue_name: queueName(context.execution, context.caller, 'dlq'),
    captured_at: instantAt(capturedMs),
    receive_complete: true,
    messages: [
      {
        message_id: messageIdOf(context),
        body: linkText(message),
        body_sha256: linkSha256(message),
        md5_of_body: linkMd5(message),
        approximate_receive_count: GOLDEN_TIMING.max_receive_count,
        approximate_first_receive_timestamp: instantAt(published + RECEIVE_DELAY_MS),
        sent_timestamp: instantAt(published),
        message_group_id: context.trial?.trial_id ?? context.partition_key,
        message_deduplication_id: context.trial?.trial_id ?? context.partition_key,
        sequence_number: sequenceNumberOf(context),
      },
    ],
  };
}

/**
 * The SQS FIFO sequence number of the trial message: a base-10 digit string, increasing with the
 * trial's slot.
 *
 * @example
 * sequenceNumberOf(context); // '18000000000000300000' for the first slot
 */
export function sequenceNumberOf(context: TrialContext): string {
  return `18${String(context.slot_ms).padStart(18, '0')}`;
}

function durableMetadata(evidence: TrialEvidence): JsonObject {
  const capturedMs = evidence.settlement.capture_ms + CAPTURE_OFFSETS.durable_metadata;
  return {
    schema_version: 1,
    record_type: 'durable_execution_metadata',
    ...trialCorrelation(evidence.context),
    function_arn: durableFunctionArn(evidence.context),
    qualifier: GOLDEN_CALLER_VERSION,
    captured_at: instantAt(capturedMs),
    started_after: instantAt(publishedMs(evidence.context)),
    list_complete: true,
    executions: evidence.trial.timeline
      .durableExecutions()
      .filter((execution) => execution.started_ms <= capturedMs)
      .map((execution) => durableExecutionAt(execution, capturedMs)),
  };
}

// What GetDurableExecution and its history returned at the capture instant.
function durableExecutionAt(execution: DurableExecutionFact, capturedMs: number): JsonObject {
  const ended = execution.end !== undefined && execution.end.at_ms <= capturedMs ? execution.end : undefined;
  return {
    durable_execution_arn: execution.arn,
    durable_execution_name: execution.name,
    status: ended?.status ?? 'RUNNING',
    started_at: instantAt(execution.started_ms),
    ...(ended === undefined ? {} : { ended_at: instantAt(ended.at_ms) }),
    version: GOLDEN_CALLER_VERSION,
    history_complete: true,
    history: execution.history.filter((fact) => fact.at_ms <= capturedMs).map((fact) => fact.event),
  };
}

// Diagnostic only (BR-RUA-037): every signal available, located by its log group, metric and
// trace names (design §9.7 naming).
function telemetry(evidence: TrialEvidence): JsonObject {
  const { context } = evidence;
  const logical = ['refund-provider', 'treatment-controller', `${context.caller}-caller`];
  const prefix = context.execution.resource_prefix;
  const available = (locators: readonly string[]): JsonObject => ({
    availability: 'available',
    locators: [...locators],
    reasons: [],
  });
  return {
    schema_version: 1,
    record_type: 'telemetry_availability',
    ...trialCorrelation(context),
    captured_at: instantAt(evidence.settlement.capture_ms + CAPTURE_OFFSETS.telemetry),
    logs: available(logical.map((name) => `/suc/study-1/${context.execution.execution_id}/${name}`)),
    metrics: available(logical.map((name) => `AWS/Lambda/Errors/suc1-${prefix}-${name}`)),
    traces: available(logical.map((name) => `xray/suc1-${prefix}-${name}`)),
  };
}
