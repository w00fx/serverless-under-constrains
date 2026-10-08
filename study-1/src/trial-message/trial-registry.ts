// The trial registry (design D-21, §9.3): one item per variant, `pk = registry#<variant_id>`,
// `sk = active`, holding the `trial_registration` of the variant's active trial. The runner
// writes it before publishing a trial message; variants only read it, with a strongly
// consistent read, to validate each delivered message (BR-RUA-036). It is neither control state
// nor the ledger, so reading it keeps a variant inside BR-RUA-018.
//
// A stored item is untrusted until checked: the guard reads own properties only and accepts
// exactly what the `trial_registration` schema accepts (differential fuzz in
// test/fuzz/trial-message), so a damaged item is reported, never thrown on.

import type { DurableItemStore, ItemKey, StoredItem } from '../durable-store/item-store-port.ts';
import { isSha256Hex } from '../record-contract/digests.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { boundedJsonText, describeJson, isJsonObject } from '../record-contract/json-value.ts';
import type { JsonObject, JsonValue, Result, VariantId } from '../record-contract/primitives.ts';
import { err, ok, VARIANT_IDS } from '../record-contract/primitives.ts';
import type { TrialRegistration } from '../record-contract/records/group-a/trial_registration.ts';
import { isUtcMillis } from '../record-contract/timestamps.ts';
import { ownField, trialExecutionOf, unexpectedField } from './trial-message-fields.ts';

/** The sort key of every variant's single registry item. */
export const TRIAL_REGISTRY_ACTIVE_SK = 'active';

export const TRIAL_REGISTRY_FAILURE_CODES = ['REGISTRY_UNREADABLE', 'REGISTRATION_INVALID'] as const;
export type TrialRegistryFailureCode = (typeof TRIAL_REGISTRY_FAILURE_CODES)[number];

export interface TrialRegistryFailure {
  readonly code: TrialRegistryFailureCode;
  readonly detail: string;
}

/** The read side of the registry, as variants see it (design §5.3). */
export interface TrialRegistryReadPort {
  /** The variant's active registration, `undefined` when none is registered. */
  activeTrial(variant: VariantId): Promise<Result<TrialRegistration | undefined, TrialRegistryFailure>>;
}

const REGISTRATION_FIELDS: ReadonlySet<string> = new Set([
  'schema_version',
  'record_type',
  'variant_id',
  'run_id',
  'variant_validation_id',
  'execution_manifest_sha256',
  'trial_id',
  'trial_manifest_sha256',
  'registry_version',
  'registered_at',
]);

/**
 * The item key of a variant's registry item.
 *
 * @example
 * trialRegistryItemKey('conventional'); // { pk: 'registry#conventional', sk: 'active' }
 */
export function trialRegistryItemKey(variant: VariantId): ItemKey {
  return { pk: `registry#${variant}`, sk: TRIAL_REGISTRY_ACTIVE_SK };
}

/**
 * The stored item of a registration: the record under its variant's key. The runner writes it
 * and tests seed it.
 *
 * @example
 * store.seed('trial_registry', toTrialRegistryItem(registration));
 */
export function toTrialRegistryItem(registration: TrialRegistration): StoredItem {
  return { ...registration, ...trialRegistryItemKey(registration.variant_id) };
}

/**
 * Checks a value against the `trial_registration` contract; the failure names the first
 * offending property and the expected shape. Total over any JSON value.
 *
 * @example
 * const checked = parseTrialRegistration(item);
 * if (checked.ok) checked.value.trial_manifest_sha256;
 */
export function parseTrialRegistration(value: JsonValue): Result<TrialRegistration, string> {
  if (!isJsonObject(value)) {
    return err(`trial registration is ${describeJson(value)}; expected a JSON object`);
  }
  const object: JsonObject = value;
  const extra = unexpectedField(object, REGISTRATION_FIELDS);
  if (extra !== undefined) {
    return err(
      `trial registration has the unexpected property ${boundedJsonText(extra)}; expected only trial_registration fields`,
    );
  }
  const execution = trialExecutionOf(object);
  if (execution === undefined) {
    return err(
      `trial registration run_id ${describeJson(ownField(object, 'run_id'))}, variant_validation_id ${describeJson(ownField(object, 'variant_validation_id'))}; expected exactly one lowercase UUIDv4`,
    );
  }
  const problem = firstRegistrationViolation(object);
  if (problem !== undefined) {
    return err(problem);
  }
  // Every field below was proven by firstRegistrationViolation; the record is rebuilt so it holds nothing else.
  const fields = {
    schema_version: 1,
    record_type: 'trial_registration',
    variant_id: object['variant_id'],
    execution_manifest_sha256: object['execution_manifest_sha256'],
    trial_id: object['trial_id'],
    trial_manifest_sha256: object['trial_manifest_sha256'],
    registry_version: object['registry_version'],
    registered_at: object['registered_at'],
  } as Omit<TrialRegistration, 'run_id' | 'variant_validation_id'>;
  return ok(
    execution.field === 'run_id'
      ? { ...fields, run_id: execution.id }
      : { ...fields, variant_validation_id: execution.id },
  );
}

interface FieldRule {
  readonly name: string;
  readonly accepts: (value: JsonValue | undefined) => boolean;
  readonly shape: string;
}

const REGISTRATION_RULES: readonly FieldRule[] = [
  { name: 'schema_version', accepts: (value) => value === 1, shape: '1' },
  { name: 'record_type', accepts: (value) => value === 'trial_registration', shape: '"trial_registration"' },
  { name: 'variant_id', accepts: isVariantId, shape: '"conventional" or "durable"' },
  { name: 'execution_manifest_sha256', accepts: isSha256Hex, shape: '64 lowercase hex characters' },
  { name: 'trial_id', accepts: isUuid4, shape: 'a lowercase UUIDv4' },
  { name: 'trial_manifest_sha256', accepts: isSha256Hex, shape: '64 lowercase hex characters' },
  { name: 'registry_version', accepts: isRegistryVersion, shape: 'an integer from 1 to 9007199254740991' },
  { name: 'registered_at', accepts: isUtcMillis, shape: 'a UTC timestamp with milliseconds' },
];

function firstRegistrationViolation(object: JsonObject): string | undefined {
  const broken = REGISTRATION_RULES.find((rule) => !rule.accepts(ownField(object, rule.name)));
  return broken === undefined
    ? undefined
    : `trial registration ${broken.name} ${describeJson(ownField(object, broken.name))}; expected ${broken.shape}`;
}

function isVariantId(value: JsonValue | undefined): boolean {
  return VARIANT_IDS.some((variant) => variant === value);
}

function isRegistryVersion(value: JsonValue | undefined): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Binds the read port to the `trial_registry` table of a durable store.
 *
 * @example
 * const registry = createStoreTrialRegistry(store);
 * const active = await registry.activeTrial('conventional');
 */
export function createStoreTrialRegistry(store: DurableItemStore): TrialRegistryReadPort {
  return {
    activeTrial: async (variant: VariantId): Promise<Result<TrialRegistration | undefined, TrialRegistryFailure>> => {
      const read = await store.getConsistent('trial_registry', trialRegistryItemKey(variant));
      if (!read.ok) {
        return err({
          code: 'REGISTRY_UNREADABLE',
          detail: `trial registry read for ${variant} failed: ${boundedJsonText(read.error.code)}`,
        });
      }
      return read.value === undefined ? ok(undefined) : registrationOfItem(read.value, variant);
    },
  };
}

function registrationOfItem(item: StoredItem, variant: VariantId): Result<TrialRegistration, TrialRegistryFailure> {
  const { pk: _pk, sk: _sk, ...record } = item;
  const parsed = parseTrialRegistration(record);
  if (!parsed.ok) {
    return err({ code: 'REGISTRATION_INVALID', detail: parsed.error });
  }
  if (parsed.value.variant_id !== variant) {
    return err({
      code: 'REGISTRATION_INVALID',
      detail: `registry item of ${variant} names variant_id ${parsed.value.variant_id}; expected ${variant}`,
    });
  }
  return parsed;
}
