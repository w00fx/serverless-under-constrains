// Phase T8 "collect into a buffer" for one trial or the probe (design §10.2 T8, §7; BR-RUA-034,
// BR-RUA-037). The collector reads, in the design's order, the ledger, the conditional DLQ capture,
// the journals, the state snapshots, the Durable metadata and the telemetry availability, and
// returns their bytes keyed by layout name; the runner writes the buffer at T10 only after the
// pre-freeze recheck (D-32), so nothing here touches the package.
//
// Collection is best effort and fails closed: a read that fails produces no file for that
// artifact and a structured reason, never a partial file presented as whole. Ingestion then
// reports the artifact missing and the gates that need it are unverified (§8.2). The ledger is the
// exception the spec names: an incomplete ledger read is still written, marked `complete: false`,
// so the pagination failure itself is evidence (AC-RUA-007). Telemetry is diagnostic and always
// written (AC-RUA-054).

import type { StructuredReason, VariantId, WallClock } from '../record-contract/primitives.ts';
import type { CaptureScope } from './capture-scope.ts';
import { capturePartitionKey, isTrialScope } from './capture-scope.ts';
import { appendEach } from './collected-records.ts';
import { keepRead, keepRecord } from './collection-buffer.ts';
import type { CollectedFile, CollectionBuffer } from './collection-buffer.ts';
import type { CollectorStoreReader } from './collected-records.ts';
import { captureDlq } from './dlq-capture.ts';
import type { DlqCapture, DlqReceiver } from './dlq-capture.ts';
import { collectDurableExecutionMetadata } from './durable-metadata.ts';
import type { DurableExecutionReader, DurableListingRequest } from './durable-metadata.ts';
import { exportJournals, unitJournalPlans } from './journal-export.ts';
import { captureLedgerSnapshot } from './ledger-capture.ts';
import type { QueueTarget } from './queue-observation.ts';
import {
  captureProviderTrialConfiguration,
  captureTreatmentSnapshot,
  captureTrialRegistration,
} from './state-capture.ts';
import { captureTelemetryAvailability } from './telemetry-availability.ts';
import type { TelemetryProbe } from './telemetry-availability.ts';

/** The ports one trial collection reads through. */
export interface TrialCollectionPorts {
  readonly store: CollectorStoreReader;
  readonly dlq: DlqReceiver;
  readonly durable: DurableExecutionReader;
  readonly telemetry: TelemetryProbe;
  readonly clock: WallClock;
}

/** What to collect: the unit, and for a trial its variant, its DLQ and its Durable listing. */
export interface TrialCollectionPlan {
  readonly scope: CaptureScope;
  /** The variant whose registry item a trial records; absent for the probe. */
  readonly variant?: VariantId;
  /** The variant's DLQ; absent for the probe, which has no queue. */
  readonly dlq?: QueueTarget;
  /** The caller version's executions; present for Durable trials only. */
  readonly durable?: DurableListingRequest;
}

/** The buffer T10 writes, and what cleanup and the next settlement sample need from it. */
export interface TrialCollection {
  readonly files: readonly CollectedFile[];
  readonly failures: readonly StructuredReason[];
  readonly ledger_complete: boolean;
  /** The DLQ capture of a queued trial; absent for the probe. */
  readonly dlq_capture?: DlqCapture;
}

/**
 * Collects every artifact of one trial or of the probe into a buffer, in the design §10.2 T8 order.
 *
 * @example
 * const collection = await collectTrialEvidence(ports, { scope, variant: 'durable', dlq, durable });
 * collection.files.map((file) => file.key); // ['ledgerSnapshot', 'callerJournal', …]
 */
export async function collectTrialEvidence(
  ports: TrialCollectionPorts,
  plan: TrialCollectionPlan,
): Promise<TrialCollection> {
  const buffer: CollectionBuffer = { files: [], failures: [] };
  const { scope } = plan;
  const ledger = await captureLedgerSnapshot(ports.store, scope, ports.clock);
  appendEach(buffer.failures, ledger.failures);
  keepRecord(buffer, 'ledgerSnapshot', ledger.record);
  const dlqCapture = await collectDlq(ports, plan, buffer);
  await collectJournals(ports.store, scope, buffer);
  await collectState(ports, plan, buffer);
  await collectDurable(ports, plan, buffer);
  keepRecord(buffer, 'telemetryAvailability', await captureTelemetryAvailability(ports.telemetry, scope, ports.clock));
  return {
    files: buffer.files,
    failures: buffer.failures,
    ledger_complete: ledger.complete,
    ...(dlqCapture === undefined ? {} : { dlq_capture: dlqCapture }),
  };
}

// The snapshot is written only when the trial's own messages were captured: it is conditional
// evidence, and ingestion requires it exactly when a sample saw a correlated message (§8.1).
async function collectDlq(
  ports: TrialCollectionPorts,
  plan: TrialCollectionPlan,
  buffer: CollectionBuffer,
): Promise<DlqCapture | undefined> {
  const { scope, dlq } = plan;
  if (dlq === undefined || !isTrialScope(scope)) {
    return undefined;
  }
  const capture = await captureDlq(ports.dlq, dlq, scope, ports.clock);
  appendEach(buffer.failures, capture.failures);
  if (capture.correlated_message_ids.length > 0) {
    keepRecord(buffer, 'dlqSnapshot', capture.record);
  }
  return capture;
}

async function collectJournals(
  store: CollectorStoreReader,
  scope: CaptureScope,
  buffer: CollectionBuffer,
): Promise<void> {
  for (const plan of unitJournalPlans(capturePartitionKey(scope))) {
    const exported = await exportJournals(store, plan);
    if (!exported.ok) {
      buffer.failures.push(exported.error);
      continue;
    }
    for (const file of exported.value) {
      buffer.files.push({ key: file.file, role: 'trial_evidence', bytes: file.bytes });
    }
  }
}

async function collectState(
  ports: TrialCollectionPorts,
  plan: TrialCollectionPlan,
  buffer: CollectionBuffer,
): Promise<void> {
  const treatment = await captureTreatmentSnapshot(ports.store, plan.scope, ports.clock);
  keepRead(buffer, 'treatmentStateSnapshot', treatment.ok ? { ok: true, value: treatment.value.record } : treatment);
  keepRead(buffer, 'providerTrialConfiguration', await captureProviderTrialConfiguration(ports.store, plan.scope));
  if (plan.variant !== undefined) {
    keepRead(buffer, 'trialRegistration', await captureTrialRegistration(ports.store, plan.variant));
  }
}

async function collectDurable(
  ports: TrialCollectionPorts,
  plan: TrialCollectionPlan,
  buffer: CollectionBuffer,
): Promise<void> {
  const { scope, durable } = plan;
  if (durable === undefined || !isTrialScope(scope)) {
    return;
  }
  const metadata = await collectDurableExecutionMetadata(ports.durable, durable, scope, ports.clock);
  appendEach(buffer.failures, metadata.failures);
  keepRecord(buffer, 'durableExecutions', metadata.record);
}
