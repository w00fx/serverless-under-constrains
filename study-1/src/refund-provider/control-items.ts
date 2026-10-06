// The control-table items the provider reads (design §9.3): the immutable `config` item (a
// `provider_trial_configuration` record), the `payment#<payment_id>` item (a `payment` record)
// and the `treatment` item (the BR-RUA-025 state, version, commit triple and signal ids). Each
// item is the record's attributes plus `pk` and `sk`.
//
// The provider decodes items with these hand-written readers instead of Ajv (no schema
// compilation on the call path, RK-01). A reader checks only the attributes the provider uses
// and refuses an item whose used attributes are malformed, because acting on a misread
// configuration or treatment state would corrupt the experiment.
//
// The configuration also declares the barrier timing. The provider runs the coded OR-RUA-002
// values (BARRIER_TIMING), so a configuration that declares other values is refused rather than
// silently misdescribing the run it is evidence for (WP-07 review round 1).

import { isSha256Hex } from '../record-contract/digests.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import type { JsonValue, Result, Scenario, Sha256Hex, Uuid4 } from '../record-contract/primitives.ts';
import { SCENARIOS } from '../record-contract/primitives.ts';
import type { ProviderCallerId } from '../record-contract/records/group-a/provider_refund_call.ts';
import { PROVIDER_CALLER_IDS } from '../record-contract/records/group-a/provider_refund_call.ts';
import type { TreatmentItem } from '../record-contract/records/group-b/treatment_state_snapshot.ts';
import type { SafetyReleaseCause, TreatmentState } from '../record-contract/records/group-b/vocabulary.ts';
import { SAFETY_RELEASE_CAUSES, TREATMENT_STATES } from '../record-contract/records/group-b/vocabulary.ts';
import type { StoredItem } from '../durable-store/item-store-port.ts';
import { BARRIER_TIMING } from './barrier-timing.ts';
import type { CallTrial } from './refund-call-shape.ts';
import { describeUntrusted } from './untrusted-json.ts';

export const CONFIG_SORT_KEY = 'config';
export const TREATMENT_SORT_KEY = 'treatment';
export const PAYMENT_SORT_KEY_PREFIX = 'payment#';

/** The parts of the frozen trial configuration the provider acts on. */
export interface ProviderConfigView {
  readonly execution_manifest_sha256: Sha256Hex;
  readonly registered_caller_id: ProviderCallerId;
  readonly scenario: Scenario;
  readonly payment_id: string;
  /** The configured trial; absent exactly for the transport-probe configuration (D-06). */
  readonly trial?: CallTrial;
}

/** The parts of the trial payment the provider compares (BR-RUA-018 checks 5 and 7). */
export interface PaymentView {
  readonly payment_id: string;
  readonly currency: string;
}

const TREATMENT_ID_FIELDS = [
  'targeted_attempt_id',
  'provider_request_id',
  'provider_call_id',
  'provider_commit_id',
  'provider_transaction_id',
  'commit_event_id',
  'signal_event_id',
  'signal_caller_event_id',
  'observed_event_id',
  'release_event_id',
] as const;

type TreatmentIdField = (typeof TREATMENT_ID_FIELDS)[number];

/**
 * The sort key of a payment item.
 *
 * @example
 * paymentSortKey('pay-poc-001'); // 'payment#pay-poc-001'
 */
export function paymentSortKey(paymentId: string): string {
  return `${PAYMENT_SORT_KEY_PREFIX}${paymentId}`;
}

/**
 * Reads a `config` item. A trial configuration must name the trial of its partition and declare
 * the barrier timing the provider runs (`BARRIER_TIMING`).
 *
 * @example
 * const config = decodeConfigItem(item, { trial_id }); // ok when item.trial_id === trial_id
 */
export function decodeConfigItem(
  item: StoredItem,
  partitionTrial: Uuid4 | undefined,
): Result<ProviderConfigView, string> {
  const scope = configScopeProblem(item, partitionTrial) ?? configTimingProblem(item);
  if (scope !== undefined) {
    return refuse(item, scope);
  }
  const digest = item['execution_manifest_sha256'];
  const caller = item['registered_caller_id'];
  const scenario = item['scenario'];
  const paymentId = item['payment_id'];
  if (!isSha256Hex(digest)) {
    return refuse(item, `execution_manifest_sha256 ${describeUntrusted(digest)}; expected 64 lowercase hex digits`);
  }
  if (!isOneOf(PROVIDER_CALLER_IDS, caller)) {
    return refuse(
      item,
      `registered_caller_id ${describeUntrusted(caller)}; expected one of ${PROVIDER_CALLER_IDS.join(', ')}`,
    );
  }
  if (!isOneOf(SCENARIOS, scenario)) {
    return refuse(item, `scenario ${describeUntrusted(scenario)}; expected one of ${SCENARIOS.join(', ')}`);
  }
  if (typeof paymentId !== 'string') {
    return refuse(item, `payment_id ${describeUntrusted(paymentId)}; expected a string`);
  }
  const view = { execution_manifest_sha256: digest, registered_caller_id: caller, scenario, payment_id: paymentId };
  return { ok: true, value: partitionTrial === undefined ? view : { ...view, trial: trialOf(item, partitionTrial) } };
}

/**
 * Reads a `payment#<payment_id>` item.
 *
 * @example
 * decodePaymentItem(item); // { ok: true, value: { payment_id: 'pay-poc-001', currency: 'BRL' } }
 */
export function decodePaymentItem(item: StoredItem): Result<PaymentView, string> {
  const paymentId = item['payment_id'];
  const currency = item['currency'];
  if (typeof paymentId !== 'string' || item.sk !== paymentSortKey(paymentId)) {
    return refuse(item, `payment_id ${describeUntrusted(paymentId)}; expected the string that names the item key`);
  }
  if (typeof currency !== 'string') {
    return refuse(item, `currency ${describeUntrusted(currency)}; expected a string`);
  }
  return { ok: true, value: { payment_id: paymentId, currency } };
}

/**
 * Reads the `treatment` item: a known state, a positive integer version, lowercase UUIDv4
 * identities where present, and a known safety-release cause where present.
 *
 * @example
 * decodeTreatmentItem(item); // { ok: true, value: { state: 'ARMED', version: 1 } }
 */
export function decodeTreatmentItem(item: StoredItem): Result<TreatmentItem, string> {
  const state = item['state'];
  const version = item['version'];
  const cause = item['safety_release_cause'];
  if (!isOneOf(TREATMENT_STATES, state)) {
    return refuse(item, `state ${describeUntrusted(state)}; expected one of ${TREATMENT_STATES.join(', ')}`);
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return refuse(item, `version ${describeUntrusted(version)}; expected a safe integer >= 1`);
  }
  const malformed = TREATMENT_ID_FIELDS.find((field) => item[field] !== undefined && !isUuid4(item[field]));
  if (malformed !== undefined) {
    return refuse(
      item,
      `${malformed} ${describeUntrusted(item[malformed])}; expected a lowercase RFC 4122 version-4 UUID`,
    );
  }
  if (cause !== undefined && !isOneOf(SAFETY_RELEASE_CAUSES, cause)) {
    return refuse(
      item,
      `safety_release_cause ${describeUntrusted(cause)}; expected one of ${SAFETY_RELEASE_CAUSES.join(', ')}`,
    );
  }
  return { ok: true, value: treatmentOf(state, version, item, cause) };
}

function configScopeProblem(item: StoredItem, partitionTrial: Uuid4 | undefined): string | undefined {
  if (partitionTrial === undefined) {
    const trialField = (['trial_id', 'trial_manifest_sha256'] as const).find((field) => item[field] !== undefined);
    return trialField === undefined
      ? undefined
      : `${trialField} present on a transport-probe configuration; expected none`;
  }
  if (item['trial_id'] !== partitionTrial) {
    return `trial_id ${describeUntrusted(item['trial_id'])}; expected the partition trial ${partitionTrial}`;
  }
  if (!isSha256Hex(item['trial_manifest_sha256'])) {
    return `trial_manifest_sha256 ${describeUntrusted(item['trial_manifest_sha256'])}; expected 64 lowercase hex digits`;
  }
  return undefined;
}

function configTimingProblem(item: StoredItem): string | undefined {
  const declared = [
    ['safety_release_ms', BARRIER_TIMING.safety_release_ms],
    ['treatment_poll_interval_ms', BARRIER_TIMING.poll_interval_ms],
  ] as const;
  const mismatch = declared.find(([field, coded]) => item[field] !== coded);
  if (mismatch === undefined) {
    return undefined;
  }
  const [field, coded] = mismatch;
  return `${field} ${describeUntrusted(item[field])}; expected ${String(coded)}, the provider's coded OR-RUA-002 value`;
}

function trialOf(item: StoredItem, partitionTrial: Uuid4): CallTrial {
  // configScopeProblem proved the digest; the cast restates it.
  return { trial_id: partitionTrial, trial_manifest_sha256: item['trial_manifest_sha256'] as Sha256Hex };
}

function treatmentOf(
  state: TreatmentState,
  version: number,
  item: StoredItem,
  cause: SafetyReleaseCause | undefined,
): TreatmentItem {
  const ids: Partial<Record<TreatmentIdField, Uuid4>> = {};
  for (const field of TREATMENT_ID_FIELDS) {
    const value = item[field];
    if (isUuid4(value)) {
      ids[field] = value;
    }
  }
  return cause === undefined ? { state, version, ...ids } : { state, version, ...ids, safety_release_cause: cause };
}

function isOneOf<T extends string>(values: readonly T[], value: JsonValue | undefined): value is T {
  return (values as readonly (JsonValue | undefined)[]).includes(value);
}

function refuse<T>(item: StoredItem, problem: string): Result<T, string> {
  return { ok: false, error: `control item ${item.pk}/${item.sk}: ${problem}` };
}
