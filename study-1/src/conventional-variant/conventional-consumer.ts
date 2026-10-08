// The conventional refund consumer (design §5.3 L3 `conventional-variant/`, BR-RUA-020): an SQS
// FIFO source, an event source mapping with batch size 1, and the shared provider client. Each
// delivery is one invocation and one new `conventional_caller` source instance (BR-RUA-033):
//
// 1. read the variant's active trial registration; without a usable one there is no trial
//    partition to journal into, so the caller faults and the message is redelivered;
// 2. record `caller_invocation_started` with the message id and receive count;
// 3. validate the message against the registration (BR-RUA-036). A rejected message is
//    journaled (`trial_message_rejected`), its request finishes MESSAGE_REJECTED with knowledge
//    unchanged, no provider is called, and the delivery completes (AC-RUA-019);
// 4. otherwise fold any orphan attempt into the request state, perform one attempt caused by the
//    invocation start, and record the request state the disposition decides (BR-RUA-024);
// 5. return the disposition: the handler throws for `propagate_failure`, so SQS redelivers.
//
// The consumer never skips a delivery because the request already finished: the conventional
// variant has no caller-side deduplication, which is what the study measures.

import type { JournalScope } from '../event-journal/journal-scope.ts';
import type { JournalWriter } from '../event-journal/journal-writer.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import type { Uuid4 } from '../record-contract/primitives.ts';
import type { TrialRegistration } from '../record-contract/records/group-a/trial_registration.ts';
import type { AttemptReport } from '../provider-client/attempt-resolution.ts';
import { AttemptNotRegisteredError } from '../provider-client/provider-client.ts';
import type { ProviderClient } from '../provider-client/provider-client.ts';
import type { ApprovedRefund } from '../trial-message/approved-refund.ts';
import type { ConsumerRejection } from '../trial-message/delivered-message.ts';
import { validateDeliveredMessage } from '../trial-message/delivered-message.ts';
import type { TrialRegistryReadPort } from '../trial-message/trial-registry.ts';
import { executionRefOf } from '../trial-message/trial-message-fields.ts';
import type { TrialExecutionRef } from '../trial-message/trial-message-fields.ts';
import type { TrialMessage } from '../record-contract/records/group-a/trial_message.ts';
import { CONVENTIONAL_MAX_RECEIVE_COUNT, decideConventionalDisposition } from './conventional-disposition.ts';
import type { ConventionalDisposition, ConventionalTerminality } from './conventional-disposition.ts';
import type { VariantDeployment } from './conventional-environment.ts';
import { ConventionalCallerFault } from './conventional-fault.ts';
import type {
  ProcessingUpdate,
  RequestStateRecorder,
  RequestStateRecordResult,
} from './request-state/request-state-recorder.ts';
import type { DeliveryContext } from './sqs-delivery.ts';

export interface ConsumerDeps {
  /** The run or variant validation this function was deployed for. */
  readonly deployment: VariantDeployment;
  /** The provider version number every attempt targets (`SUC_PROVIDER_QUALIFIER`). */
  readonly provider_qualifier: string;
  /** The refund every attempt requests (OR-RUA-001). */
  readonly refund: ApprovedRefund;
  readonly registry: TrialRegistryReadPort;
  /** A new `conventional_caller` source instance writing to the caller journal. */
  readonly openJournal: (scope: JournalScope) => JournalWriter;
  /** The shared provider client over that journal. */
  readonly openClient: (journal: JournalWriter, scope: JournalScope) => ProviderClient;
  /** The request-state recorder over that journal. */
  readonly openRecorder: (journal: JournalWriter, scope: JournalScope) => RequestStateRecorder;
}

/** One invocation of the consumer: its journal, its invocation start and its delivery. */
interface Invocation {
  readonly lambda_request_id: string;
  readonly delivery: DeliveryContext;
  readonly scope: JournalScope;
  readonly journal: JournalWriter;
  readonly recorder: RequestStateRecorder;
  readonly started_event_id: Uuid4;
}

export class ConventionalRefundConsumer {
  readonly #deps: ConsumerDeps;

  constructor(deps: ConsumerDeps) {
    this.#deps = deps;
  }

  /**
   * Consumes one delivery and returns its disposition. Throws a ConventionalCallerFault when the
   * delivery cannot be processed with complete evidence, so SQS redelivers it.
   *
   * @example
   * const disposition = await consumer.consume(delivery, context.awsRequestId);
   * if (disposition.kind === 'propagate_failure') throw new DeliveryFailurePropagated(...);
   */
  async consume(delivery: DeliveryContext, lambdaRequestId: string): Promise<ConventionalDisposition> {
    const registration = await this.#activeRegistration(lambdaRequestId);
    const scope: JournalScope = {
      execution: this.#deps.deployment,
      execution_manifest_sha256: registration.execution_manifest_sha256,
      partition: {
        kind: 'trial',
        trial_id: registration.trial_id,
        trial_manifest_sha256: registration.trial_manifest_sha256,
      },
    };
    const journal = this.#deps.openJournal(scope);
    const started = await journal.append('caller_invocation_started', {
      lambda_request_id: lambdaRequestId,
      message_id: delivery.message_id,
      approximate_receive_count: delivery.approximate_receive_count,
    });
    if (started.kind === 'stopped') {
      throw journalFault(lambdaRequestId, 'caller_invocation_started', started.reason);
    }
    const invocation: Invocation = {
      lambda_request_id: lambdaRequestId,
      delivery,
      scope,
      journal,
      recorder: this.#deps.openRecorder(journal, scope),
      started_event_id: started.event.event_id,
    };
    const validation = validateDeliveredMessage(delivery.body, registration);
    return validation.kind === 'rejected'
      ? this.#reject(invocation, validation)
      : this.#attempt(invocation, validation.message);
  }

  async #activeRegistration(lambdaRequestId: string): Promise<TrialRegistration> {
    const active = await this.#deps.registry.activeTrial('conventional');
    if (!active.ok) {
      throw new ConventionalCallerFault(
        'REGISTRY_UNREADABLE',
        lambdaRequestId,
        `${active.error.code}: ${active.error.detail}`,
      );
    }
    if (active.value === undefined) {
      throw new ConventionalCallerFault(
        'NO_ACTIVE_TRIAL',
        lambdaRequestId,
        'the trial registry holds no active conventional trial; expected the runner to register the trial before publishing its message',
      );
    }
    const registered = executionRefOf(active.value);
    const deployed = deployedExecutionRef(this.#deps.deployment);
    if (registered.field !== deployed.field || registered.id !== deployed.id) {
      throw new ConventionalCallerFault(
        'REGISTRATION_MISMATCH',
        lambdaRequestId,
        `the active conventional registration names ${registered.field} ${registered.id}; expected the deployed ${deployed.field} ${deployed.id}`,
      );
    }
    return active.value;
  }

  async #reject(invocation: Invocation, rejection: ConsumerRejection): Promise<ConventionalDisposition> {
    const { journal, delivery, lambda_request_id } = invocation;
    const { kind: _kind, ...fields } = rejection;
    const rejected = await journal.append(
      'trial_message_rejected',
      {
        ...fields,
        message_id: delivery.message_id,
        message_body_sha256: sha256Hex(new TextEncoder().encode(delivery.body)),
      },
      [invocation.started_event_id],
    );
    if (rejected.kind === 'stopped') {
      throw journalFault(lambda_request_id, 'trial_message_rejected', rejected.reason);
    }
    const request =
      rejection.refund_request_id === undefined ? undefined : { refund_request_id: rejection.refund_request_id };
    const recorded = await invocation.recorder.recordMessageRejected(request, {
      message_id: delivery.message_id,
      causation_event_ids: [rejected.event.event_id],
    });
    assertRecorded(recorded, lambda_request_id, 'MESSAGE_REJECTED');
    return { kind: 'complete' };
  }

  async #attempt(invocation: Invocation, message: TrialMessage): Promise<ConventionalDisposition> {
    const { lambda_request_id, delivery, recorder } = invocation;
    const request = { refund_request_id: message.refund_request_id };
    const reconciled = await recorder.reconcileOrphans(request, [invocation.started_event_id]);
    assertRecorded(reconciled, lambda_request_id, 'the orphan reconciliation');
    const report = await this.#performAttempt(invocation, message);
    if (report.outcome_event_id === undefined) {
      throw new ConventionalCallerFault(
        'JOURNAL_STOPPED',
        lambda_request_id,
        `attempt ${report.attempt_id} ended ${report.outcome} without its attempt_outcome_recorded event; the next delivery reconciles it`,
      );
    }
    const decision = decideConventionalDisposition(
      report,
      delivery.approximate_receive_count,
      CONVENTIONAL_MAX_RECEIVE_COUNT,
    );
    const recorded = await recorder.recordAttemptResult(
      request,
      { attempt_id: report.attempt_id, outcome_class: report.outcome_class },
      processingUpdateOf(decision.terminality),
      [report.outcome_event_id],
    );
    assertRecorded(recorded, lambda_request_id, `the state after attempt ${report.attempt_id}`);
    return decision.disposition;
  }

  async #performAttempt(invocation: Invocation, message: TrialMessage): Promise<AttemptReport> {
    const client = this.#deps.openClient(invocation.journal, invocation.scope);
    try {
      return await client.performAttempt({
        caller_id: 'conventional',
        refund_request_id: message.refund_request_id,
        payment_id: message.payment_id,
        amount_minor: this.#deps.refund.amount_minor,
        currency: this.#deps.refund.currency,
        provider_qualifier: this.#deps.provider_qualifier,
        causation_event_ids: [invocation.started_event_id],
      });
    } catch (error: unknown) {
      if (error instanceof AttemptNotRegisteredError) {
        throw new ConventionalCallerFault('ATTEMPT_NOT_REGISTERED', invocation.lambda_request_id, error.message);
      }
      throw error;
    }
  }
}

function deployedExecutionRef(deployment: VariantDeployment): TrialExecutionRef {
  return deployment.execution_kind === 'RUN'
    ? { field: 'run_id', id: deployment.run_id }
    : { field: 'variant_validation_id', id: deployment.variant_validation_id };
}

function processingUpdateOf(terminality: ConventionalTerminality): ProcessingUpdate {
  return terminality.processing_state === 'RUNNING'
    ? { processing_state: 'RUNNING' }
    : { processing_state: 'FINISHED', terminal_reason: terminality.terminal_reason };
}

function assertRecorded(result: RequestStateRecordResult, lambdaRequestId: string, what: string): void {
  if (result.kind === 'not_recorded') {
    throw new ConventionalCallerFault(
      'STATE_NOT_RECORDED',
      lambdaRequestId,
      `${what} not recorded: ${result.code}: ${result.detail}`,
    );
  }
}

function journalFault(lambdaRequestId: string, eventType: string, reason: string): ConventionalCallerFault {
  return new ConventionalCallerFault('JOURNAL_STOPPED', lambdaRequestId, `${eventType} not written: ${reason}`);
}
