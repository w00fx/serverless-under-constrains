// Step 3 (BR-RUA-048 "disables consumers and prevents new processing"; design §10.4):
// `UpdateEventSourceMapping(Enabled=false)` on both sources and the stream, then wait until each
// mapping reports `Disabled`. A mapping already gone counts as disabled. A mapping still not
// `Disabled` after the polling budget fails the step, and cleanup goes on: deleting the stack
// removes the mapping anyway, and the leak audit proves whether it is gone.

import { boundedJsonText } from '../record-contract/json-value.ts';
import type { Sleeper, StructuredReason } from '../record-contract/primitives.ts';
import type { ConsumerControlPort } from './cleanup-ports.ts';
import { ITEM_ACTIONS } from './cleanup-steps.ts';
import { EVENT_SOURCE_MAPPING_RESOURCE_TYPE } from './resource-types.ts';
import type { ItemRecorder, StepOutcome } from './step-recording.ts';
import { outcomeFromFailures } from './step-recording.ts';

/** Delay between `State` reads while a mapping is disabling. */
export const CONSUMER_POLL_INTERVAL_MS = 5_000;
/** Reads of `State` before the step gives up on one mapping: two minutes at the interval above. */
export const CONSUMER_MAX_POLLS = 24;
const DISABLED_STATE = 'Disabled';

type DisableResult =
  { readonly kind: 'disabled' | 'absent' } | { readonly kind: 'failed'; readonly reason: StructuredReason };

/**
 * Disables every event-source mapping and waits for each to report `Disabled`.
 *
 * @example
 * const outcome = await disableConsumers(['3f1c…-mapping'], consumers, sleeper, record);
 * outcome.status; // 'succeeded'
 */
export async function disableConsumers(
  mappingIds: readonly string[],
  port: ConsumerControlPort,
  sleeper: Sleeper,
  record: ItemRecorder,
): Promise<StepOutcome> {
  const failures: StructuredReason[] = [];
  for (const mappingId of mappingIds) {
    const result = await disableOne(mappingId, port, sleeper);
    const named = { resource_type: EVENT_SOURCE_MAPPING_RESOURCE_TYPE, resource_identifier: mappingId };
    if (result.kind === 'failed') {
      failures.push(result.reason);
      await record({ ...named, action: ITEM_ACTIONS.consumerDisableFailed, reasons: [result.reason] });
      continue;
    }
    const action = result.kind === 'disabled' ? ITEM_ACTIONS.consumerDisabled : ITEM_ACTIONS.consumerAbsent;
    await record({ ...named, action });
  }
  return outcomeFromFailures(failures);
}

async function disableOne(mappingId: string, port: ConsumerControlPort, sleeper: Sleeper): Promise<DisableResult> {
  const request = await port.requestDisable(mappingId);
  if (request.kind !== 'requested') {
    return request;
  }
  let lastState = 'unread';
  for (let poll = 1; poll <= CONSUMER_MAX_POLLS; poll += 1) {
    const read = await port.readState(mappingId);
    if (read.kind === 'absent' || (read.kind === 'state' && read.state === DISABLED_STATE)) {
      return { kind: read.kind === 'absent' ? 'absent' : 'disabled' };
    }
    lastState = read.kind === 'state' ? read.state : `unreadable (${read.reason.code})`;
    if (poll < CONSUMER_MAX_POLLS) {
      await sleeper.sleep(CONSUMER_POLL_INTERVAL_MS);
    }
  }
  return {
    kind: 'failed',
    reason: {
      code: 'CONSUMER_NOT_DISABLED',
      subject: mappingId,
      detail: `event-source mapping state ${boundedJsonText(lastState)} after ${String(CONSUMER_MAX_POLLS)} reads; expected ${DISABLED_STATE}`,
    },
  };
}
