// P3 readiness (design §10.2; D-10): before the first trial every event-source mapping of the
// deployed stack reports `State=Enabled`, and the treatment controller has acknowledged the
// runner's readiness canary. The canary is a runner-written `caller_timeout_recorded` in the caller
// journal's `<execution_id>#canary` partition (it names no trial); the controller, reading the
// stream, answers with `controller_canary_acknowledged` in the experiment journal's partition of
// the same key. Both waits poll on the injected sleeper and give up at a bound, so a stuck mapping
// or a deaf controller stops the execution before any trial instead of hanging it.

import type { ConsumerControlPort } from '../cleanup/cleanup-ports.ts';
import type { DurableItemStore } from '../durable-store/item-store-port.ts';
import { createDurableJournalPort } from '../event-journal/durable-journal-port.ts';
import { JournalWriter } from '../event-journal/journal-writer.ts';
import { executionPartitionKey } from '../evidence-collection/capture-scope.ts';
import type { DecimalString, StructuredReason, Uuid4 } from '../record-contract/primitives.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { AdmittedExecution, ExecutionServices } from './execution-ports.ts';

/** How long readiness waits for the mappings and for the canary acknowledgement. */
export const READINESS_TIMEOUT_MS = 300_000;
/** The interval between readiness polls. */
export const READINESS_POLL_MS = 5_000;
/** The `refund_request_id` that marks the canary as no trial's call (D-10). */
export const CANARY_REFUND_REQUEST_ID = 'readiness-canary';

const ENABLED = 'Enabled';

/** What readiness reads and writes. */
export interface ReadinessPorts {
  readonly consumers: ConsumerControlPort;
  readonly store: DurableItemStore;
  readonly services: ExecutionServices;
}

/**
 * Waits until every mapping is enabled and the controller acknowledged the canary; the reasons it
 * is not ready, empty when it is. `causation` is the runner event the canary follows.
 *
 * @example
 * const reasons = await confirmReadiness(ports, admitted, targets.event_source_mapping_ids, readinessStartedId);
 * if (reasons.length > 0) await emergencyCleanup();
 */
export async function confirmReadiness(
  ports: ReadinessPorts,
  admitted: AdmittedExecution,
  mappingIds: readonly string[],
  causation: Uuid4,
): Promise<readonly StructuredReason[]> {
  const mappings = await awaitMappingsEnabled(ports, mappingIds);
  if (mappings.length > 0) {
    return mappings;
  }
  return awaitCanaryAcknowledged(ports, admitted, causation);
}

async function awaitMappingsEnabled(
  ports: ReadinessPorts,
  mappingIds: readonly string[],
): Promise<readonly StructuredReason[]> {
  let waiting = await notEnabled(ports.consumers, mappingIds);
  for (let waited = 0; waiting.length > 0 && waited < READINESS_TIMEOUT_MS; waited += READINESS_POLL_MS) {
    await ports.services.sleeper.sleep(READINESS_POLL_MS);
    waiting = await notEnabled(
      ports.consumers,
      waiting.map(([mappingId]) => mappingId),
    );
  }
  return waiting.map(([mappingId, state]) =>
    readinessReason(
      'EVENT_SOURCE_MAPPING_NOT_ENABLED',
      `event-source mapping ${mappingId} is ${state} after ${String(READINESS_TIMEOUT_MS)} ms; expected State=${ENABLED}`,
    ),
  );
}

// Each mapping that is not enabled yet, with what its last read showed.
async function notEnabled(
  consumers: ConsumerControlPort,
  mappingIds: readonly string[],
): Promise<readonly (readonly [string, string])[]> {
  const waiting: (readonly [string, string])[] = [];
  for (const mappingId of mappingIds) {
    const read = await consumers.readState(mappingId);
    const shown =
      read.kind === 'state' ? `State=${read.state}` : read.kind === 'absent' ? 'absent' : read.reason.detail;
    if (read.kind !== 'state' || read.state !== ENABLED) {
      waiting.push([mappingId, shown]);
    }
  }
  return waiting;
}

async function awaitCanaryAcknowledged(
  ports: ReadinessPorts,
  admitted: AdmittedExecution,
  causation: Uuid4,
): Promise<readonly StructuredReason[]> {
  const written = await writeCanary(ports, admitted, causation);
  if (written !== undefined) {
    return [written];
  }
  const partition = executionPartitionKey(admitted.identity, admitted.manifest_sha256, 'canary');
  for (let waited = 0; waited <= READINESS_TIMEOUT_MS; waited += READINESS_POLL_MS) {
    if (await acknowledged(ports.store, partition)) {
      return [];
    }
    await ports.services.sleeper.sleep(READINESS_POLL_MS);
  }
  return [
    readinessReason(
      'CANARY_NOT_ACKNOWLEDGED',
      `no controller_canary_acknowledged in experiment_journal ${partition} after ${String(READINESS_TIMEOUT_MS)} ms; expected the controller to answer the readiness canary`,
    ),
  ];
}

async function writeCanary(
  ports: ReadinessPorts,
  admitted: AdmittedExecution,
  causation: Uuid4,
): Promise<StructuredReason | undefined> {
  const { ids, clock } = ports.services;
  const canary = new JournalWriter({
    port: createDurableJournalPort(ports.store, 'caller_journal'),
    source: 'runner',
    instanceId: ids.next(),
    scope: {
      execution: admitted.identity,
      execution_manifest_sha256: admitted.manifest_sha256,
      partition: { kind: 'canary' },
    },
    clock,
    ids,
    maxDefinitiveRetries: 0,
  });
  const now = formatUtcMillis(clock.now());
  const appended = await canary.append(
    'caller_timeout_recorded',
    {
      attempt_id: ids.next(),
      provider_request_id: ids.next(),
      refund_request_id: CANARY_REFUND_REQUEST_ID,
      elapsed_ns: '0' as DecimalString,
      monotonic_origin_event_id: causation,
      dispatch_at: now,
      deadline_at: now,
      timer_fired_at: now,
      abort_requested_at: now,
      recorded_at: now,
      arbiter_winner: 'TIMER',
      transport_settled_at_claim: false,
    },
    [causation],
  );
  return appended.kind === 'appended'
    ? undefined
    : readinessReason(
        'CANARY_NOT_WRITTEN',
        `the readiness canary was not appended (${appended.reason}: ${appended.detail}); expected it in caller_journal`,
      );
}

// A failed read counts as not acknowledged yet; the next poll reads again.
async function acknowledged(store: DurableItemStore, partition: string): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await store.queryPartitionPage('experiment_journal', partition, cursor);
    if (!page.ok) {
      return false;
    }
    if (page.value.items.some((item) => item['record_type'] === 'controller_canary_acknowledged')) {
      return true;
    }
    cursor = page.value.next_cursor;
  } while (cursor !== undefined);
  return false;
}

function readinessReason(code: string, detail: string): StructuredReason {
  return { code, subject: 'D-10', detail };
}
