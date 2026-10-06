// A received call that names no configured trial partition (Owner amendment A-09, human
// decision; AC-RUA-042): a payload without a well-formed `trial_id`, or a trial with no frozen
// configuration in this execution. The provider reads the execution configuration item with a
// consistent read and appends `provider_call_rejected` to the execution-level partition
// `<execution_id>#provider` under its manifest digest: a fresh provider-generated
// `provider_call_id`, the failed acceptance check as `reason` and a bounded `detail`. It creates
// no transaction, consumes no treatment and reads nothing else. Without the execution
// configuration the call cannot be journaled; that only happens before execution start, when no
// trial can run, and the provider then faults with the original cause (documented residual).

import type { JournalScope } from '../event-journal/journal-scope.ts';
import type { JournalWriter } from '../event-journal/journal-writer.ts';
import type { ExecutionIdentity, JsonValue, Uuid4 } from '../record-contract/primitives.ts';
import type { ProviderRefundResponse } from '../record-contract/records/group-a/provider_refund_response.ts';
import { judgeUnattributedCall } from './acceptance.ts';
import { CONFIG_SORT_KEY, executionConfigPartition } from './control-items.ts';
import type { ProviderFaultCode } from './provider-fault.ts';
import { ProviderFault } from './provider-fault.ts';
import { unattributedJournalScope } from './provider-partition.ts';
import type { ProviderStatePort } from './provider-state-port.ts';
import { rejectedResponse } from './rejected-response.ts';

export interface UnattributedCallDeps {
  readonly deployment: ExecutionIdentity;
  readonly state: Pick<ProviderStatePort, 'loadExecutionConfiguration'>;
  /** Opens a journal writer with a new source instance. */
  readonly openJournal: (scope: JournalScope) => JournalWriter;
}

/** Why no trial partition takes the call: the fault the provider raises when it cannot journal it. */
export interface UnattributedCause {
  readonly code: Extract<ProviderFaultCode, 'UNATTRIBUTABLE_CALL' | 'CONFIGURATION_MISSING'>;
  readonly detail: string;
}

/**
 * Rejects and journals one unattributed call, returning the REJECTED response. Throws a
 * ProviderFault when the execution configuration is absent (the cause's code), unreadable
 * (`STATE_UNREADABLE`) or the rejection cannot be recorded (`JOURNAL_STOPPED`).
 *
 * @example
 * const response = await rejectUnattributedCall(deps, raw, providerCallId, { code: 'UNATTRIBUTABLE_CALL', detail });
 */
export async function rejectUnattributedCall(
  deps: UnattributedCallDeps,
  raw: JsonValue,
  providerCallId: Uuid4,
  cause: UnattributedCause,
): Promise<ProviderRefundResponse> {
  const read = await deps.state.loadExecutionConfiguration(deps.deployment);
  if (!read.ok) {
    const detail = `${read.error.detail}; expected a consistent read of the execution configuration`;
    throw new ProviderFault('STATE_UNREADABLE', 'before_commit', providerCallId, detail);
  }
  if (read.value === undefined) {
    const item = `${executionConfigPartition(deps.deployment)}/${CONFIG_SORT_KEY}`;
    const detail = `${cause.detail}; no execution configuration at control ${item}, so the rejection cannot be journaled (A-09)`;
    throw new ProviderFault(cause.code, 'before_commit', providerCallId, detail);
  }
  const digest = read.value.execution_manifest_sha256;
  const decision = judgeUnattributedCall(raw, {
    deployment_execution: deps.deployment,
    execution_manifest_sha256: digest,
  });
  const journal = deps.openJournal(unattributedJournalScope(deps.deployment, digest));
  const body = { provider_call_id: providerCallId, reason: decision.reason, detail: decision.detail };
  const appended = await journal.append('provider_call_rejected', body);
  if (appended.kind === 'stopped') {
    const detail = `provider_call_rejected not recorded (${appended.reason}); expected a writable source instance`;
    throw new ProviderFault('JOURNAL_STOPPED', 'before_commit', providerCallId, detail);
  }
  return rejectedResponse(providerCallId, raw, decision.reason);
}
