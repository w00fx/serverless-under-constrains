// Phases T2-T5 of one capture unit, a trial or the transport probe (design §10.2, §9.3;
// BR-RUA-019, BR-RUA-036, D-21):
//   T2 every trial table holds nothing under the unit's partition (one consistent Query each)
//      -> trial_partitions_verified_absent
//   T3 the provider's configuration and the payment in `control`, then, for a trial, the
//      variant's registry item names this trial (conditional on the version the runner last
//      read); the probe has no variant and no registry item (D-06)
//   T4 a treatment unit arms its `treatment` item -> treatment_armed
//   T5 the publication gate is open
// Every write is conditional, so a leftover item from another unit is refused instead of
// overwritten; any refusal, read failure or unwritten runner event rejects the setup before
// publication (or, for the probe, before its Invoke), and nothing starts. The probe runs the same
// steps in `<execution_id>#probe` (evidence/CMP-04/decisions.md: generalized, not copied).

import type { Condition, DurableItemStore, StoredItem, WriteAction } from '../durable-store/item-store-port.ts';
import { capturePartitionKey, correlationFields } from '../evidence-collection/capture-scope.ts';
import type { CaptureScope } from '../evidence-collection/capture-scope.ts';
import type { JournalEvent } from '../event-journal/journal-event.ts';
import type { Result, Scenario, StructuredReason, VariantId, WallClock } from '../record-contract/primitives.ts';
import type { Payment } from '../record-contract/records/group-a/payment.ts';
import type { ProviderCallerId } from '../record-contract/records/group-a/provider_refund_call.ts';
import type { TrialRegistration } from '../record-contract/records/group-a/trial_registration.ts';
import { TRIAL_PARTITION_TABLE_ROLES } from '../record-contract/records/group-b/vocabulary.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { CONFIG_SORT_KEY, TREATMENT_SORT_KEY, paymentSortKey } from '../refund-provider/control-items.ts';
import { parseTrialRegistration, toTrialRegistryItem, trialRegistryItemKey } from '../trial-message/trial-registry.ts';
import type { RunnerUnitJournal } from './runner-trial-journal.ts';
import type { ProviderTiming, PublicationGate } from './trial-execution-ports.ts';

const SUBJECT = 'BR-RUA-019';

/** The provider configuration of the unit (OR-RUA-002; the probe's caller is `probe`). */
export interface UnitConfiguration {
  readonly registered_caller_id: ProviderCallerId;
  readonly scenario: Scenario;
  readonly payment: Payment;
  readonly timing: ProviderTiming;
}

/** What T2-T4 act on. */
export interface UnitSetupContext {
  readonly store: DurableItemStore;
  readonly journal: RunnerUnitJournal;
  readonly clock: WallClock;
  /** The execution and the trial or probe; its partition is `<execution_id>#<trial_id|probe>`. */
  readonly scope: CaptureScope;
  readonly configuration: UnitConfiguration;
  /** The variant whose registry item a trial takes; absent for the probe, which registers nothing. */
  readonly registry_variant?: VariantId;
}

/**
 * T2: proves with consistent reads that no trial table holds an item under the partition, then
 * records it. Empty when verified; otherwise every reason.
 *
 * @example
 * const reasons = await verifyPartitionsAbsent(context); // [] for a fresh trial
 */
export async function verifyPartitionsAbsent(context: UnitSetupContext): Promise<readonly StructuredReason[]> {
  const partitionKey = capturePartitionKey(context.scope);
  const reasons: StructuredReason[] = [];
  for (const role of TRIAL_PARTITION_TABLE_ROLES) {
    const page = await context.store.queryPartitionPage(role, partitionKey);
    if (!page.ok) {
      reasons.push(
        setupReason('PARTITION_UNREADABLE', `${role} partition ${partitionKey} read failed with ${page.error.code}`),
      );
      continue;
    }
    if (page.value.items.length > 0 || page.value.next_cursor !== undefined) {
      reasons.push(setupReason('PARTITION_NOT_EMPTY', `${role} partition ${partitionKey} holds items`));
    }
  }
  if (reasons.length > 0) {
    return reasons;
  }
  return recorded(
    await context.journal.record('trial_partitions_verified_absent', {
      partition_key: partitionKey,
      table_roles: [...TRIAL_PARTITION_TABLE_ROLES],
    }),
  );
}

/**
 * T3: writes the provider configuration, the payment and, for a trial, the variant's registration.
 *
 * @example
 * const reasons = await writeControlItems(context);
 */
export async function writeControlItems(context: UnitSetupContext): Promise<readonly StructuredReason[]> {
  const { configuration: unit } = context;
  const pk = capturePartitionKey(context.scope);
  const configuration: StoredItem = {
    pk,
    sk: CONFIG_SORT_KEY,
    schema_version: 1,
    record_type: 'provider_trial_configuration',
    ...correlationFields(context.scope),
    registered_caller_id: unit.registered_caller_id,
    scenario: unit.scenario,
    payment_id: unit.payment.payment_id,
    safety_release_ms: unit.timing.safety_release_ms,
    treatment_poll_interval_ms: unit.timing.treatment_poll_interval_ms,
    written_at: formatUtcMillis(context.clock.now()),
  };
  const payment: StoredItem = { ...unit.payment, pk, sk: paymentSortKey(unit.payment.payment_id) };
  for (const item of [configuration, payment]) {
    const refused = await writeOnce(context.store, { kind: 'put', table: 'control', item, condition: ABSENT });
    if (refused !== undefined) {
      return [refused];
    }
  }
  return context.registry_variant === undefined ? [] : registerTrial(context, context.registry_variant);
}

/**
 * T4: arms the treatment of a COMMIT_THEN_TIMEOUT unit; a CONTROL trial has no treatment item.
 *
 * @example
 * const reasons = await armTreatment(context); // [] and `treatment_armed` journaled
 */
export async function armTreatment(context: UnitSetupContext): Promise<readonly StructuredReason[]> {
  if (context.configuration.scenario === 'CONTROL') {
    return [];
  }
  const pk = capturePartitionKey(context.scope);
  const item: StoredItem = { pk, sk: TREATMENT_SORT_KEY, state: 'ARMED', version: 1 };
  const refused = await writeOnce(context.store, { kind: 'put', table: 'control', item, condition: ABSENT });
  if (refused !== undefined) {
    return [refused];
  }
  return recorded(
    await context.journal.record('treatment_armed', {
      partition_key: pk,
      treatment_state: 'ARMED',
      treatment_version: 1,
    }),
  );
}

/**
 * T5: lease CONFIRMED ∧ safety.mayStartTrial() ∧ no interruption (design §10.2); the reason the
 * gate is closed, or `undefined` when it is open.
 *
 * @example
 * const closed = gateClosed(gate);
 * if (closed !== undefined) return notStarted([closed]);
 */
export function gateClosed(gate: PublicationGate): StructuredReason | undefined {
  const interruption = gate.interruption();
  const open = gate.publicationAllowed() && gate.mayStartTrial() && interruption === undefined;
  if (open) {
    return undefined;
  }
  const why =
    interruption === undefined
      ? 'publication is not allowed or no trial may start'
      : `${interruption.cause}: ${interruption.detail}`;
  return {
    code: 'PUBLICATION_GATE_CLOSED',
    subject: 'BR-RUA-045',
    detail: `the publication gate is closed (${why}); expected a confirmed lease, safety headroom and no interruption`,
  };
}

const ABSENT: Condition = { kind: 'item_absent' };

// D-21: the registry item is written conditionally on the version the runner read, so two
// runners can never both believe they registered; the version increases with every write.
async function registerTrial(context: UnitSetupContext, variant: VariantId): Promise<readonly StructuredReason[]> {
  const key = trialRegistryItemKey(variant);
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
    ...correlationFields(context.scope),
    variant_id: variant,
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

function recorded(written: Result<JournalEvent, StructuredReason>): readonly StructuredReason[] {
  return written.ok ? [] : [written.error];
}

function setupReason(code: string, problem: string): StructuredReason {
  return { code, subject: SUBJECT, detail: `${problem}; expected a clean setup before publication` };
}
