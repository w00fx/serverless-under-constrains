// The control-table items the controller reads (design §9.3, §9.6): the immutable `config` item
// (a `provider_trial_configuration` record) and the `treatment` item (the BR-RUA-025 state and
// the identities each state carries). The controller's IAM grant is GetItem and conditional
// UpdateItem on `control`, so these readers are its only view of treatment.
//
// Readers check only what the controller acts on, by hand instead of Ajv (no schema compilation
// on the stream path). A treatment item must carry every identity its state implies: a committed
// wait names the targeted attempt and the commit, and a signalled state also names the caller
// event that signalled it. An item without them cannot be judged against BR-RUA-025, so it is
// refused as unreadable state instead of guessed at.

import type { StoredItem } from '../durable-store/item-store-port.ts';
import { isSha256Hex } from '../record-contract/digests.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import type { JsonValue, Result, Scenario, Sha256Hex, Uuid4 } from '../record-contract/primitives.ts';
import { SCENARIOS } from '../record-contract/primitives.ts';
import type { CallerId, SignalledTreatmentState } from '../record-contract/records/group-b/vocabulary.ts';
import { CALLER_IDS, TREATMENT_STATES } from '../record-contract/records/group-b/vocabulary.ts';
import type { ExperimentPartition } from './controller-partition.ts';
import { describeUntrustedValue } from './untrusted-value.ts';

export const CONFIG_SORT_KEY = 'config';
export const TREATMENT_SORT_KEY = 'treatment';

/** The trial identity a trial partition's configuration declares. */
export interface ConfiguredTrial {
  readonly trial_id: Uuid4;
  readonly trial_manifest_sha256: Sha256Hex;
}

/** The parts of the frozen provider configuration the controller acts on. */
export interface ControllerConfigView {
  readonly execution_manifest_sha256: Sha256Hex;
  readonly registered_caller_id: CallerId;
  readonly scenario: Scenario;
  /** Present exactly in a trial partition; the probe has no trial (D-06). */
  readonly trial?: ConfiguredTrial;
}

/** The commit a committed wait belongs to (written by the targeted provider commit). */
export interface TreatmentCommit {
  readonly targeted_attempt_id: Uuid4;
  readonly provider_commit_id: Uuid4;
  /** The `provider_transaction_committed` event of the targeted commit. */
  readonly commit_event_id: Uuid4;
}

/** The treatment item as the controller decides on it (design §9.11). */
export type ControllerTreatment =
  | { readonly state: 'ARMED' }
  | ({ readonly state: 'COMMITTED_WAITING' } & TreatmentCommit)
  | ({ readonly state: SignalledTreatmentState; readonly signal_caller_event_id: Uuid4 } & TreatmentCommit)
  | { readonly state: 'SAFETY_RELEASED' };

/**
 * Reads a `config` item of an experiment partition. A trial configuration must name the
 * partition's trial and its manifest digest; a probe configuration names no trial.
 *
 * @example
 * decodeControllerConfig(item, { kind: 'probe', key }); // { ok: true, value: { scenario: 'COMMIT_THEN_TIMEOUT', ... } }
 */
export function decodeControllerConfig(
  item: StoredItem,
  partition: ExperimentPartition,
): Result<ControllerConfigView, string> {
  const digest = item['execution_manifest_sha256'];
  const caller = item['registered_caller_id'];
  const scenario = item['scenario'];
  if (!isSha256Hex(digest)) {
    return refuse(
      item,
      `execution_manifest_sha256 ${describeUntrustedValue(digest)}; expected 64 lowercase hex digits`,
    );
  }
  if (!isOneOf(CALLER_IDS, caller)) {
    return refuse(
      item,
      `registered_caller_id ${describeUntrustedValue(caller)}; expected one of ${CALLER_IDS.join(', ')}`,
    );
  }
  if (!isOneOf(SCENARIOS, scenario)) {
    return refuse(item, `scenario ${describeUntrustedValue(scenario)}; expected one of ${SCENARIOS.join(', ')}`);
  }
  const view = { execution_manifest_sha256: digest, registered_caller_id: caller, scenario };
  if (partition.kind === 'probe') {
    const trialField = (['trial_id', 'trial_manifest_sha256'] as const).find((field) => item[field] !== undefined);
    return trialField === undefined
      ? { ok: true, value: view }
      : refuse(item, `${trialField} present on a transport-probe configuration; expected none`);
  }
  const trial = configuredTrial(item, partition.trial_id);
  return trial.ok ? { ok: true, value: { ...view, trial: trial.value } } : trial;
}

/**
 * Reads the `treatment` item: a known state, a positive integer version, and every identity
 * the state implies, each a lowercase UUIDv4.
 *
 * @example
 * decodeControllerTreatment({ pk, sk: 'treatment', state: 'ARMED', version: 1 }); // { ok: true, value: { state: 'ARMED' } }
 */
export function decodeControllerTreatment(item: StoredItem): Result<ControllerTreatment, string> {
  const state = item['state'];
  const version = item['version'];
  if (!isOneOf(TREATMENT_STATES, state)) {
    return refuse(item, `state ${describeUntrustedValue(state)}; expected one of ${TREATMENT_STATES.join(', ')}`);
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return refuse(item, `version ${describeUntrustedValue(version)}; expected a safe integer >= 1`);
  }
  if (state === 'ARMED' || state === 'SAFETY_RELEASED') {
    return { ok: true, value: { state } };
  }
  const commit = treatmentCommit(item, state);
  if (!commit.ok) {
    return commit;
  }
  if (state === 'COMMITTED_WAITING') {
    return { ok: true, value: { state, ...commit.value } };
  }
  const signal = requiredId(item, 'signal_caller_event_id', state);
  return signal.ok ? { ok: true, value: { state, ...commit.value, signal_caller_event_id: signal.value } } : signal;
}

function configuredTrial(item: StoredItem, partitionTrial: Uuid4): Result<ConfiguredTrial, string> {
  const trialDigest = item['trial_manifest_sha256'];
  if (item['trial_id'] !== partitionTrial) {
    return refuse(
      item,
      `trial_id ${describeUntrustedValue(item['trial_id'])}; expected the partition trial ${partitionTrial}`,
    );
  }
  if (!isSha256Hex(trialDigest)) {
    return refuse(
      item,
      `trial_manifest_sha256 ${describeUntrustedValue(trialDigest)}; expected 64 lowercase hex digits`,
    );
  }
  return { ok: true, value: { trial_id: partitionTrial, trial_manifest_sha256: trialDigest } };
}

function treatmentCommit(item: StoredItem, state: string): Result<TreatmentCommit, string> {
  const targeted = requiredId(item, 'targeted_attempt_id', state);
  if (!targeted.ok) {
    return targeted;
  }
  const commitId = requiredId(item, 'provider_commit_id', state);
  if (!commitId.ok) {
    return commitId;
  }
  const commitEvent = requiredId(item, 'commit_event_id', state);
  if (!commitEvent.ok) {
    return commitEvent;
  }
  return {
    ok: true,
    value: {
      targeted_attempt_id: targeted.value,
      provider_commit_id: commitId.value,
      commit_event_id: commitEvent.value,
    },
  };
}

function requiredId(item: StoredItem, field: string, state: string): Result<Uuid4, string> {
  const value = item[field];
  if (!isUuid4(value)) {
    return refuse(
      item,
      `${field} ${describeUntrustedValue(value)} in state ${state}; expected a lowercase RFC 4122 version-4 UUID`,
    );
  }
  return { ok: true, value };
}

function isOneOf<T extends string>(values: readonly T[], value: JsonValue | undefined): value is T {
  return (values as readonly (JsonValue | undefined)[]).includes(value);
}

function refuse<T>(item: StoredItem, problem: string): Result<T, string> {
  return { ok: false, error: `control item ${item.pk}/${item.sk}: ${problem}` };
}
