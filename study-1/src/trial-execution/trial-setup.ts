// Phases T2-T4 of one trial (design §10.2, §9.3; BR-RUA-019, BR-RUA-036, D-21):
//   T2 every trial table holds nothing under the trial partition (one consistent Query each)
//      -> trial_partitions_verified_absent
//   T3 the provider's trial configuration and the payment in `control`, then the variant's
//      registry item names this trial (conditional on the version the runner last read)
//   T4 a treatment trial arms its `treatment` item -> treatment_armed
// Every write is conditional, so a leftover item from another trial is refused instead of
// overwritten; any refusal, read failure or unwritten runner event rejects the setup before
// publication, and no trial starts.

import type { Condition, DurableItemStore, StoredItem, WriteAction } from '../durable-store/item-store-port.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import type { JournalEvent } from '../event-journal/journal-event.ts';
import type { Result, Sha256Hex, StructuredReason, WallClock } from '../record-contract/primitives.ts';
import type { TrialRegistration } from '../record-contract/records/group-a/trial_registration.ts';
import { TRIAL_PARTITION_TABLE_ROLES } from '../record-contract/records/group-b/vocabulary.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { CONFIG_SORT_KEY, TREATMENT_SORT_KEY, paymentSortKey } from '../refund-provider/control-items.ts';
import { parseTrialRegistration, toTrialRegistryItem, trialRegistryItemKey } from '../trial-message/trial-registry.ts';
import type { RunnerTrialJournal } from './runner-trial-journal.ts';
import type { TrialPlan } from './trial-execution-ports.ts';

const SUBJECT = 'BR-RUA-019';

/** What T2-T4 act on. */
export interface TrialSetupContext {
  readonly store: DurableItemStore;
  readonly journal: RunnerTrialJournal;
  readonly clock: WallClock;
  readonly plan: TrialPlan;
  readonly manifest_sha256: Sha256Hex;
  /** `<execution_id>#<trial_id>`. */
  readonly partition_key: string;
}

/**
 * T2: proves with consistent reads that no trial table holds an item under the partition, then
 * records it. Empty when verified; otherwise every reason.
 *
 * @example
 * const reasons = await verifyPartitionsAbsent(context); // [] for a fresh trial
 */
export async function verifyPartitionsAbsent(context: TrialSetupContext): Promise<readonly StructuredReason[]> {
  const reasons: StructuredReason[] = [];
  for (const role of TRIAL_PARTITION_TABLE_ROLES) {
    const page = await context.store.queryPartitionPage(role, context.partition_key);
    if (!page.ok) {
      reasons.push(
        setupReason(
          'PARTITION_UNREADABLE',
          `${role} partition ${context.partition_key} read failed with ${page.error.code}`,
        ),
      );
      continue;
    }
    if (page.value.items.length > 0 || page.value.next_cursor !== undefined) {
      reasons.push(setupReason('PARTITION_NOT_EMPTY', `${role} partition ${context.partition_key} holds items`));
    }
  }
  if (reasons.length > 0) {
    return reasons;
  }
  return recorded(
    await context.journal.record('trial_partitions_verified_absent', {
      partition_key: context.partition_key,
      table_roles: [...TRIAL_PARTITION_TABLE_ROLES],
    }),
  );
}

/**
 * T3: writes the trial configuration, the payment and the variant's registration.
 *
 * @example
 * const reasons = await writeTrialControlItems(context);
 */
export async function writeTrialControlItems(context: TrialSetupContext): Promise<readonly StructuredReason[]> {
  const { plan, partition_key: pk } = context;
  const writtenAt = formatUtcMillis(context.clock.now());
  const configuration: StoredItem = {
    pk,
    sk: CONFIG_SORT_KEY,
    schema_version: 1,
    record_type: 'provider_trial_configuration',
    ...trialCorrelation(context),
    registered_caller_id: plan.trial.variant_id,
    scenario: plan.trial.scenario,
    payment_id: plan.payment.payment_id,
    safety_release_ms: plan.provider_timing.safety_release_ms,
    treatment_poll_interval_ms: plan.provider_timing.treatment_poll_interval_ms,
    written_at: writtenAt,
  };
  const payment: StoredItem = { ...plan.payment, pk, sk: paymentSortKey(plan.payment.payment_id) };
  for (const item of [configuration, payment]) {
    const refused = await writeOnce(context.store, { kind: 'put', table: 'control', item, condition: ABSENT });
    if (refused !== undefined) {
      return [refused];
    }
  }
  return registerTrial(context);
}

/**
 * T4: arms the treatment of a COMMIT_THEN_TIMEOUT trial; a CONTROL trial has no treatment item.
 *
 * @example
 * const reasons = await armTreatment(context); // [] and `treatment_armed` journaled
 */
export async function armTreatment(context: TrialSetupContext): Promise<readonly StructuredReason[]> {
  if (context.plan.trial.scenario === 'CONTROL') {
    return [];
  }
  const item: StoredItem = { pk: context.partition_key, sk: TREATMENT_SORT_KEY, state: 'ARMED', version: 1 };
  const refused = await writeOnce(context.store, { kind: 'put', table: 'control', item, condition: ABSENT });
  if (refused !== undefined) {
    return [refused];
  }
  return recorded(
    await context.journal.record('treatment_armed', {
      partition_key: context.partition_key,
      treatment_state: 'ARMED',
      treatment_version: 1,
    }),
  );
}

const ABSENT: Condition = { kind: 'item_absent' };

// D-21: the registry item is written conditionally on the version the runner read, so two
// runners can never both believe they registered; the version increases with every write.
async function registerTrial(context: TrialSetupContext): Promise<readonly StructuredReason[]> {
  const key = trialRegistryItemKey(context.plan.trial.variant_id);
  const read = await context.store.getConsistent('trial_registry', key);
  if (!read.ok) {
    return [setupReason('REGISTRY_UNREADABLE', `registry item ${key.pk} read failed with ${read.error.code}`)];
  }
  const previous = previousVersion(read.value);
  if (typeof previous === 'string') {
    return [setupReason('REGISTRY_UNREADABLE', previous)];
  }
  const registration = {
    schema_version: 1,
    record_type: 'trial_registration',
    ...trialCorrelation(context),
    variant_id: context.plan.trial.variant_id,
    registry_version: previous + 1,
    registered_at: formatUtcMillis(context.clock.now()),
  } as TrialRegistration;
  const condition: Condition =
    previous === 0 ? ABSENT : { kind: 'attribute_equals', name: 'registry_version', value: previous };
  const refused = await writeOnce(context.store, {
    kind: 'put',
    table: 'trial_registry',
    item: toTrialRegistryItem(registration),
    condition,
  });
  return refused === undefined ? [] : [refused];
}

// 0 when no trial of the variant was registered yet; a text when the stored item is unreadable.
function previousVersion(item: StoredItem | undefined): number | string {
  if (item === undefined) {
    return 0;
  }
  const { pk: _pk, sk: _sk, ...stored } = item;
  const parsed = parseTrialRegistration(stored);
  return parsed.ok ? parsed.value.registry_version : `registry item ${item.pk} is invalid: ${parsed.error}`;
}

async function writeOnce(
  store: DurableItemStore,
  action: WriteAction & { readonly kind: 'put' },
): Promise<StructuredReason | undefined> {
  const outcome = await store.write(action);
  if (outcome.kind === 'applied') {
    return undefined;
  }
  return setupReason(
    'SETUP_WRITE_NOT_APPLIED',
    `${action.table} item ${action.item.pk}/${action.item.sk} write was ${outcome.kind}`,
  );
}

function trialCorrelation(context: TrialSetupContext): Readonly<Record<string, string>> {
  return {
    ...executionIdentityFields(context.plan.execution),
    execution_manifest_sha256: context.plan.execution_manifest_sha256,
    trial_id: context.plan.trial.trial_id,
    trial_manifest_sha256: context.manifest_sha256,
  };
}

function recorded(written: Result<JournalEvent, StructuredReason>): readonly StructuredReason[] {
  return written.ok ? [] : [written.error];
}

function setupReason(code: string, problem: string): StructuredReason {
  return { code, subject: SUBJECT, detail: `${problem}; expected a clean trial setup before publication` };
}
