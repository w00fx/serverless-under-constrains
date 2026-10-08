// The transport probe's caller (design §5.3 L3 `transport-probe-caller/`, BR-RUA-027). The runner
// invokes it once, synchronously, after the readiness canary and the provider warm-up. It records
// the invocation start in the caller journal and performs exactly one attempt through the shared
// provider client (BR-RUA-028), caused by that start event. It never retries: the probe measures
// one attempt through the treatment sequence, and its verdict counts exactly one.

import type { JournalScope } from '../event-journal/journal-scope.ts';
import type { JournalWriter } from '../event-journal/journal-writer.ts';
import type { JsonValue, Uuid4 } from '../record-contract/primitives.ts';
import type { ExecutionIdentity } from '../record-contract/primitives.ts';
import type { AttemptReport } from '../provider-client/attempt-resolution.ts';
import type { ProviderClient } from '../provider-client/provider-client.ts';
import { ProbeCallerFault } from './probe-caller-fault.ts';
import { parseProbeWorkloadRequest } from './probe-workload-request.ts';

export interface ProbeCallerDeps {
  readonly deployment: ExecutionIdentity;
  /** The provider version number every attempt targets (`SUC_PROVIDER_QUALIFIER`). */
  readonly provider_qualifier: string;
  /** A new `probe_caller` source instance writing to the caller journal. */
  readonly openJournal: (scope: JournalScope) => JournalWriter;
  /** The shared provider client over that journal. */
  readonly openClient: (journal: JournalWriter, scope: JournalScope) => ProviderClient;
}

/** One synchronous invocation: the payload and the Lambda request id. */
export interface ProbeWorkloadInput {
  readonly payload: JsonValue;
  readonly lambda_request_id: string;
}

/** What the runner receives back: the invocation and its single attempt. */
export interface ProbeWorkloadReport {
  readonly transport_probe_id: Uuid4;
  readonly lambda_request_id: string;
  readonly invocation_event_id: Uuid4;
  readonly attempt: AttemptReport;
}

export class ProbeCaller {
  readonly #deps: ProbeCallerDeps;

  constructor(deps: ProbeCallerDeps) {
    this.#deps = deps;
  }

  /**
   * Runs the probe workload: one recorded invocation, one attempt. Throws a ProbeCallerFault
   * before any provider call when the request is invalid or the start cannot be recorded.
   *
   * @example
   * const report = await caller.run({ payload, lambda_request_id: context.awsRequestId });
   * report.attempt.outcome; // 'TIMED_OUT' when treatment held the response past the deadline
   */
  async run(input: ProbeWorkloadInput): Promise<ProbeWorkloadReport> {
    const request = parseProbeWorkloadRequest(input.payload, this.#deps.deployment);
    if (!request.ok) {
      throw new ProbeCallerFault('REQUEST_INVALID', input.lambda_request_id, request.error);
    }
    const workload = request.value;
    const scope: JournalScope = {
      execution: this.#deps.deployment,
      execution_manifest_sha256: workload.execution_manifest_sha256,
      partition: { kind: 'probe' },
    };
    const journal = this.#deps.openJournal(scope);
    const started = await journal.append('caller_invocation_started', { lambda_request_id: input.lambda_request_id });
    if (started.kind === 'stopped') {
      throw new ProbeCallerFault(
        'JOURNAL_STOPPED',
        input.lambda_request_id,
        `caller_invocation_started not written: ${started.reason}`,
      );
    }
    const attempt = await this.#deps.openClient(journal, scope).performAttempt({
      caller_id: 'probe',
      refund_request_id: workload.refund_request_id,
      payment_id: workload.payment_id,
      amount_minor: workload.amount_minor,
      currency: workload.currency,
      provider_qualifier: this.#deps.provider_qualifier,
      causation_event_ids: [started.event.event_id],
    });
    return {
      transport_probe_id: workload.transport_probe_id,
      lambda_request_id: input.lambda_request_id,
      invocation_event_id: started.event.event_id,
      attempt,
    };
  }
}
