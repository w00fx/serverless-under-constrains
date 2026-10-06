// Steps 7 and 8 (BR-RUA-048 "captures correlated DLQ evidence", then "deletes captured
// run-owned DLQ messages"; design §10.4). Only captured messages are ever deleted, so a message
// that never reached the evidence package stays in the queue (and its loss would be visible in
// the leak audit through the queue, never silent). A captured message that is no longer in the
// queue counts as deleted, like any already-absent owned resource (AC-RUA-011).

import type { CleanupMode } from '../record-contract/records/group-b/vocabulary.ts';
import type { CleanupEvidencePort, DlqMessagePort } from './cleanup-ports.ts';
import { ITEM_ACTIONS } from './cleanup-steps.ts';
import { DLQ_MESSAGE_RESOURCE_TYPE } from './resource-types.ts';
import type { ItemRecorder, StepOutcome } from './step-recording.ts';
import { outcomeFromFailures } from './step-recording.ts';

/**
 * Step 7: captures DLQ evidence through its owning feature and records each captured message.
 *
 * @example
 * await captureDlqEvidence('NORMAL', evidence, record); // one DLQ_MESSAGE_CAPTURED per message
 */
export async function captureDlqEvidence(
  mode: CleanupMode,
  evidence: CleanupEvidencePort,
  record: ItemRecorder,
): Promise<StepOutcome> {
  const report = await evidence.captureDlqEvidence(mode);
  for (const messageId of [...new Set(report.captured_message_ids)].sort()) {
    await record({
      action: ITEM_ACTIONS.dlqMessageCaptured,
      resource_type: DLQ_MESSAGE_RESOURCE_TYPE,
      resource_identifier: messageId,
    });
  }
  return { status: report.status, reasons: report.reasons };
}

/**
 * Step 8: deletes the captured messages that no run has deleted yet.
 *
 * @example
 * await deleteCapturedDlqMessages(['m-1'], dlq, record); // DLQ_MESSAGE_DELETED for m-1
 */
export async function deleteCapturedDlqMessages(
  messageIds: readonly string[],
  port: DlqMessagePort,
  record: ItemRecorder,
): Promise<StepOutcome> {
  if (messageIds.length === 0) {
    return outcomeFromFailures([]);
  }
  const report = await port.deleteCaptured(messageIds);
  const named = (messageId: string): { readonly resource_type: string; readonly resource_identifier: string } => ({
    resource_type: DLQ_MESSAGE_RESOURCE_TYPE,
    resource_identifier: messageId,
  });
  for (const messageId of report.deleted) {
    await record({ ...named(messageId), action: ITEM_ACTIONS.dlqMessageDeleted });
  }
  for (const messageId of report.absent) {
    await record({ ...named(messageId), action: ITEM_ACTIONS.dlqMessageAbsent });
  }
  for (const failure of report.failed) {
    await record({
      ...named(failure.message_id),
      action: ITEM_ACTIONS.dlqMessageDeleteFailed,
      reasons: [failure.reason],
    });
  }
  return outcomeFromFailures(report.failed.map((failure) => failure.reason));
}
