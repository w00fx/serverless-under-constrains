// What a reader of a fixture observes about its subject trial, derived from the primary evidence
// files alone and never from the builder: the Expected Configured Trace counts (spec table
// "Expected Configured Trace"), the final treatment state (BR-RUA-025), the processing terminal
// reason the caller recorded, and an independent re-derivation of settlement from the frozen
// samples, written from the design §8.12 pseudo-code. The base golden tests compare these
// observations with the expectations each base case states from the spec.

import { isJsonArray, isJsonObject } from '../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { recordText } from '../../support/golden-builder/golden-event-log.ts';
import { fixtureRecords } from './golden-harness.ts';
import type { LoadedGoldenCase } from './golden-harness.ts';

/** Settlement as §8.12 derives it from the samples. */
export type SettlementDerivation =
  | {
      readonly status: 'established';
      readonly window_start: string;
      readonly established_at: string;
      readonly rechecked_at: string;
    }
  | { readonly status: 'not_established' };

// BR-RUA-032 stabilization interval (OR-RUA-002 / OR-RUA-004): 120 s.
const STABILIZATION_MS = 120_000;

/**
 * The observable outcome of a fixture's subject trial, in the shape of a base case's `expected`.
 *
 * @example
 * expectedMismatches(loaded.golden_case.expected, observeSubject(loaded)); // []
 */
export function observeSubject(loaded: LoadedGoldenCase): JsonObject {
  const directory = loaded.subject_directory;
  const records = (path: string): readonly JsonObject[] => optionalRecords(loaded, `${directory}/${path}`);
  const configuration = firstRecord(records('state/provider-trial-configuration.json'));
  const durable = firstRecord(records('execution-metadata/durable-executions.json'));
  const treatment = firstRecord(records('state/treatment-state-snapshot.json'));
  const requestStates = records('journals/caller-journal.jsonl').filter(
    (record) => record['record_type'] === 'request_state_recorded',
  );
  const lastState = requestStates.toSorted((a, b) => Number(a['version']) - Number(b['version'])).at(-1);
  return {
    subject: { caller: member(configuration, 'registered_caller_id'), scenario: member(configuration, 'scenario') },
    configured_trace: {
      published_messages: runnerEvents(loaded, 'trial_message_published').length,
      source_deliveries: sourceDeliveries(records('journals/caller-journal.jsonl')),
      provider_calls: records('journals/provider-journal.jsonl').filter(
        (record) => record['record_type'] === 'provider_call_received',
      ).length,
      durable_attempts: durable === undefined ? null : durableStepAttempts(durable),
      successful_transactions: successfulTransactions(firstRecord(records('ledger/ledger-snapshot.json'))),
    },
    treatment_final_state:
      treatment?.['item_present'] === true ? member(objectMember(treatment, 'treatment'), 'state') : null,
    settlement_status: member(runnerEvents(loaded, 'settlement_assessed').at(-1), 'status'),
    processing_terminal_reason:
      lastState?.['processing_state'] === 'FINISHED' ? member(lastState, 'processing_terminal_reason') : null,
  };
}

/**
 * The runner journal's events of one type that belong to the subject trial; the probe owns every
 * runner event after the phase transitions, since its execution has no other trial.
 *
 * @example
 * runnerEvents(loaded, 'settlement_assessed').at(-1)?.['status']; // 'established'
 */
export function runnerEvents(loaded: LoadedGoldenCase, recordType: string): readonly JsonObject[] {
  const trialId = loaded.subject_directory.startsWith('trials/')
    ? loaded.subject_directory.slice('trials/'.length)
    : undefined;
  return fixtureRecords(loaded.files, 'runner/runner-journal.jsonl').filter(
    (record) => record['record_type'] === recordType && (trialId === undefined || record['trial_id'] === trialId),
  );
}

/**
 * The §8.12 evaluator over frozen samples: quiet, activity, the stabilization window started by
 * the first quiet sample, and establishment by a quiet pre-freeze recheck after the window.
 *
 * @example
 * deriveSettlement(samples, Date.parse('2026-10-05T12:15:05Z')).status; // 'established'
 */
export function deriveSettlement(samples: readonly JsonObject[], deadlineMs: number): SettlementDerivation {
  let previous: JsonObject | undefined;
  let window: number | undefined;
  let quietUntil: number | undefined;
  const ordered = samples.toSorted((a, b) => observedMs(a) - observedMs(b));
  for (const sample of ordered.filter((item) => observedMs(item) <= deadlineMs)) {
    const active = activity(sample, previous);
    previous = sample;
    if (active) {
      [window, quietUntil] = [undefined, undefined];
      continue;
    }
    window ??= observedMs(sample);
    const recheck = sample['phase'] === 'pre_freeze_recheck';
    if (!recheck && observedMs(sample) - window >= STABILIZATION_MS) {
      quietUntil = observedMs(sample);
    }
    if (quietUntil !== undefined && recheck) {
      return established(window, quietUntil, observedMs(sample));
    }
  }
  return { status: 'not_established' };
}

function established(window: number, quietUntil: number, recheckedAt: number): SettlementDerivation {
  return {
    status: 'established',
    window_start: new Date(window).toISOString(),
    established_at: new Date(quietUntil).toISOString(),
    rechecked_at: new Date(recheckedAt).toISOString(),
  };
}

function quiet(sample: JsonObject): boolean {
  const source = sample['source_queue'];
  const dlq = sample['dlq'];
  const correlated = stringItems(sample['correlated_dlq_message_ids']);
  const captured = stringItems(sample['dlq_captured_message_ids']);
  return (
    sample['publication_stopped'] === true &&
    sample['processing_terminal'] === true &&
    sample['inner_executions_terminal'] !== false &&
    sample['provider_active_calls'] === 0 &&
    sample['provider_held_barriers'] === 0 &&
    sample['provider_pending_releases'] === 0 &&
    sample['treatment_terminal'] !== false &&
    sample['ledger_snapshot_possible'] === true &&
    (source === 'not_applicable' || counterTotal(source) === 0) &&
    (dlq === 'not_applicable' || counterTotal(dlq) <= captured.length) &&
    correlated.every((id) => captured.includes(id))
  );
}

function activity(sample: JsonObject, previous: JsonObject | undefined): boolean {
  if (!quiet(sample)) {
    return true;
  }
  if (previous === undefined) {
    return false;
  }
  const previousIds = stringItems(previous['correlated_dlq_message_ids']);
  return (
    Number(sample['correlated_event_watermark']) > Number(previous['correlated_event_watermark']) ||
    sample['ledger_item_count'] !== previous['ledger_item_count'] ||
    stringItems(sample['correlated_dlq_message_ids']).some((id) => !previousIds.includes(id))
  );
}

// Queue counters in a sample; 'unavailable' or any other non-object is never quiet (§8.12).
function counterTotal(counters: JsonValue | undefined): number {
  if (!isJsonObject(counters)) {
    return Number.POSITIVE_INFINITY;
  }
  return Number(counters['visible']) + Number(counters['in_flight']) + Number(counters['delayed']);
}

function observedMs(sample: JsonObject): number {
  return Date.parse(recordText(sample, 'observed_at'));
}

function stringItems(value: JsonValue | undefined): readonly string[] {
  return isJsonArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// BR-RUA-019 counts a Lambda receive of the source message as a delivery: each one has its own
// ApproximateReceiveCount, while Durable step re-invocations of one delivery share it. The probe
// is invoked directly, so its invocation carries no receive count and makes no delivery.
function sourceDeliveries(callerRecords: readonly JsonObject[]): number {
  const counts = callerRecords
    .filter((record) => record['record_type'] === 'caller_invocation_started')
    .map((record) => record['approximate_receive_count'])
    .filter((count) => typeof count === 'number');
  return new Set(counts).size;
}

function durableStepAttempts(metadata: JsonObject): number {
  return arrayMember(metadata, 'executions')
    .flatMap((execution) => (isJsonObject(execution) ? arrayMember(execution, 'history') : []))
    .filter((event) => isJsonObject(event) && event['event_type'] === 'StepStarted').length;
}

function successfulTransactions(ledger: JsonObject | undefined): number {
  const transactions = ledger === undefined ? [] : arrayMember(ledger, 'transactions');
  return transactions.filter((transaction) => isJsonObject(transaction) && transaction['status'] === 'SUCCEEDED')
    .length;
}

function arrayMember(record: JsonObject, key: string): readonly JsonValue[] {
  const value = record[key];
  return isJsonArray(value) ? value : [];
}

function optionalRecords(loaded: LoadedGoldenCase, path: string): readonly JsonObject[] {
  return loaded.files.has(path) ? fixtureRecords(loaded.files, path) : [];
}

function firstRecord(records: readonly JsonObject[]): JsonObject | undefined {
  return records[0];
}

function member(record: JsonObject | undefined, key: string): JsonValue {
  return record !== undefined && Object.hasOwn(record, key) ? (record[key] ?? null) : null;
}

function objectMember(record: JsonObject, key: string): JsonObject | undefined {
  const value = member(record, key);
  return isJsonObject(value) ? value : undefined;
}
