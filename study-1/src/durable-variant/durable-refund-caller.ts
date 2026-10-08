// One step attempt of the Durable refund caller (design §5.3 L3 `durable-variant/`, BR-RUA-020).
// The durable SDK runs this inside the execution's one step, so every journal write sits inside
// a step (design §5.3) and a replay of the handler never repeats a write. Each step attempt runs
// in its own Lambda invocation (a retry suspends the execution and Lambda re-invokes it after the
// delay), so each is one new `durable_caller` source instance (BR-RUA-033):
//
// 1. read the variant's active trial registration; without a usable one there is no trial
//    partition to journal into, so the step attempt faults and the step retry strategy decides;
// 2. record `caller_invocation_started` with the message id, receive count, durable execution
//    ARN and step attempt (the attempt projection reads them, design §8.9);
// 3. validate the message against the registration (BR-RUA-036). A rejected message is
//    journaled (`trial_message_rejected`), its request finishes MESSAGE_REJECTED with knowledge
//    unchanged, no provider is called, and the step completes (AC-RUA-019);
// 4. otherwise fold any orphan attempt into the request state, perform one attempt caused by the
//    invocation start, and record the request state the step disposition decides (BR-RUA-024);
// 5. a definitive answer completes the step; any other outcome throws `StepAttemptFailed`, after
//    recording `inner_execution_exhausted` when this was the last step attempt.
//
// The caller never skips an attempt because the request already finished: the variant has no
// caller-side deduplication, which is what the study measures.

import type { JournalScope } from '../event-journal/journal-scope.ts';
import type { JournalWriter } from '../event-journal/journal-writer.ts';
import type { TerminalityDecision } from '../attempt-lifecycle/terminality.ts';
import type { AttemptReport } from '../provider-client/attempt-resolution.ts';
import { AttemptNotRegisteredError } from '../provider-client/provider-client.ts';
import type { ProviderClient } from '../provider-client/provider-client.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import type { Uuid4 } from '../record-contract/primitives.ts';
import type { TrialMessage } from '../record-contract/records/group-a/trial_message.ts';
import type { TrialRegistration } from '../record-contract/records/group-a/trial_registration.ts';
import type { ApprovedRefund } from '../trial-message/approved-refund.ts';
import type { ConsumerRejection } from '../trial-message/delivered-message.ts';
import { validateDeliveredMessage } from '../trial-message/delivered-message.ts';
import type { TrialRegistryReadPort } from '../trial-message/trial-registry.ts';
import { executionRefOf } from '../trial-message/trial-message-fields.ts';
import type { TrialExecutionRef } from '../trial-message/trial-message-fields.ts';
import type {
  ProcessingUpdate,
  RequestStateRecorder,
  RequestStateRecordResult,
} from '../conventional-variant/request-state/request-state-recorder.ts';
import { decideDurableStep } from './durable-disposition.ts';
import type { DurableDefinitiveFinish, DurableStepDisposition } from './durable-disposition.ts';
import type { DurableDeployment } from './durable-environment.ts';
import { DurableCallerFault, StepAttemptFailed } from './durable-fault.ts';
import type { DurableDelivery } from './durable-sqs-delivery.ts';

/** The Lambda invocation and durable execution one step attempt runs in. */
export interface DurableInvocation {
  readonly lambda_request_id: string;
  readonly durable_execution_arn: string;
  /** The SDK's 1-based step attempt number (`StepContext.attempt`). */
  readonly step_attempt: number;
}

/** What a completed step checkpoints and the execution returns (JSON, the SDK's default serdes). */
export interface DurableStepResult {
  readonly terminal_reason: DurableDefinitiveFinish['terminal_reason'] | 'MESSAGE_REJECTED';
}

export interface DurableCallerDeps {
  /** The run or variant validation this function was deployed for. */
  readonly deployment: DurableDeployment;
  /** The provider version number every attempt targets (`SUC_PROVIDER_QUALIFIER`). */
  readonly provider_qualifier: string;
  /** The refund every attempt requests (OR-RUA-001). */
  readonly refund: ApprovedRefund;
  readonly registry: TrialRegistryReadPort;
  /** A new `durable_caller` source instance writing to the caller journal. */
  readonly openJournal: (scope: JournalScope) => JournalWriter;
  /** The shared provider client over that journal. */
  readonly openClient: (journal: JournalWriter, scope: JournalScope) => ProviderClient;
  /** The request-state recorder over that journal. */
  readonly openRecorder: (journal: JournalWriter, scope: JournalScope) => RequestStateRecorder;
}

/** One step attempt in progress: its journal, its invocation start and its delivery. */
interface StepAttemptRun {
  readonly invocation: DurableInvocation;
  readonly delivery: DurableDelivery;
  readonly scope: JournalScope;
  readonly journal: JournalWriter;
  readonly recorder: RequestStateRecorder;
  readonly started_event_id: Uuid4;
}

export class DurableRefundCaller {
  readonly #deps: DurableCallerDeps;

  constructor(deps: DurableCallerDeps) {
    this.#deps = deps;
  }

  /**
   * Runs one step attempt over `delivery` and returns the step result. Throws a
   * StepAttemptFailed when the provider attempt was not definitive, and a DurableCallerFault when
   * the step attempt cannot be done with complete evidence; both leave the next move to the step
   * retry strategy.
   *
   * @example
   * const result = await caller.runStepAttempt(delivery, { lambda_request_id: context.awsRequestId,
   *   durable_execution_arn: arn, step_attempt: step.attempt }); // { terminal_reason: 'SUCCEEDED' }
   */
  async runStepAttempt(delivery: DurableDelivery, invocation: DurableInvocation): Promise<DurableStepResult> {
    const registration = await this.#activeRegistration(invocation.lambda_request_id);
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
      lambda_request_id: invocation.lambda_request_id,
      message_id: delivery.message_id,
      approximate_receive_count: delivery.approximate_receive_count,
      durable_execution_arn: invocation.durable_execution_arn,
      step_attempt: invocation.step_attempt,
    });
    if (started.kind === 'stopped') {
      throw journalFault(invocation, 'caller_invocation_started', started.reason);
    }
    const run: StepAttemptRun = {
      invocation,
      delivery,
      scope,
      journal,
      recorder: this.#deps.openRecorder(journal, scope),
      started_event_id: started.event.event_id,
    };
    const validation = validateDeliveredMessage(delivery.body, registration);
    return validation.kind === 'rejected' ? this.#reject(run, validation) : this.#attempt(run, validation.message);
  }

  async #activeRegistration(lambdaRequestId: string): Promise<TrialRegistration> {
    const active = await this.#deps.registry.activeTrial('durable');
    if (!active.ok) {
      throw new DurableCallerFault(
        'REGISTRY_UNREADABLE',
        lambdaRequestId,
        `${active.error.code}: ${active.error.detail}`,
      );
    }
    if (active.value === undefined) {
      throw new DurableCallerFault(
        'NO_ACTIVE_TRIAL',
        lambdaRequestId,
        'the trial registry holds no active durable trial; expected the runner to register the trial before publishing its message',
      );
    }
    const registered = executionRefOf(active.value);
    const deployed = deployedExecutionRef(this.#deps.deployment);
    if (registered.field !== deployed.field || registered.id !== deployed.id) {
      throw new DurableCallerFault(
        'REGISTRATION_MISMATCH',
        lambdaRequestId,
        `the active durable registration names ${registered.field} ${registered.id}; expected the deployed ${deployed.field} ${deployed.id}`,
      );
    }
    return active.value;
  }

  async #reject(run: StepAttemptRun, rejection: ConsumerRejection): Promise<DurableStepResult> {
    const { journal, delivery, invocation } = run;
    const { kind: _kind, ...fields } = rejection;
    const rejected = await journal.append(
      'trial_message_rejected',
      {
        ...fields,
        message_id: delivery.message_id,
        message_body_sha256: sha256Hex(new TextEncoder().encode(delivery.body)),
      },
      [run.started_event_id],
    );
    if (rejected.kind === 'stopped') {
      throw journalFault(invocation, 'trial_message_rejected', rejected.reason);
    }
    const request =
      rejection.refund_request_id === undefined ? undefined : { refund_request_id: rejection.refund_request_id };
    const recorded = await run.recorder.recordMessageRejected(request, {
      message_id: delivery.message_id,
      causation_event_ids: [rejected.event.event_id],
    });
    assertRecorded(recorded, invocation, 'MESSAGE_REJECTED');
    return { terminal_reason: 'MESSAGE_REJECTED' };
  }

  async #attempt(run: StepAttemptRun, message: TrialMessage): Promise<DurableStepResult> {
    const { invocation, recorder } = run;
    const request = { refund_request_id: message.refund_request_id };
    const reconciled = await recorder.reconcileOrphans(request, [run.started_event_id]);
    assertRecorded(reconciled, invocation, 'the orphan reconciliation');
    const report = await this.#performAttempt(run, message);
    const outcomeEventId = report.outcome_event_id;
    if (outcomeEventId === undefined) {
      throw new DurableCallerFault(
        'JOURNAL_STOPPED',
        invocation.lambda_request_id,
        `attempt ${report.attempt_id} ended ${report.outcome} without its attempt_outcome_recorded event; the next step attempt reconciles it`,
      );
    }
    const disposition = decideDurableStep({
      outcome_class: report.outcome_class,
      step_attempt: invocation.step_attempt,
      receive_count: run.delivery.approximate_receive_count,
    });
    const recorded = await recorder.recordAttemptResult(
      request,
      { attempt_id: report.attempt_id, outcome_class: report.outcome_class },
      processingUpdateOf(disposition.terminality),
      [outcomeEventId],
    );
    assertRecorded(recorded, invocation, `the state after attempt ${report.attempt_id}`);
    return this.#conclude(run, message, report, disposition, outcomeEventId);
  }

  async #conclude(
    run: StepAttemptRun,
    message: TrialMessage,
    report: AttemptReport,
    disposition: DurableStepDisposition,
    outcomeEventId: Uuid4,
  ): Promise<DurableStepResult> {
    if (disposition.kind === 'complete') {
      return { terminal_reason: disposition.terminality.terminal_reason };
    }
    const { invocation } = run;
    if (disposition.kind === 'inner_exhausted') {
      const exhausted = await run.journal.append(
        'inner_execution_exhausted',
        {
          refund_request_id: message.refund_request_id,
          durable_execution_arn: invocation.durable_execution_arn,
          step_attempts: invocation.step_attempt,
          approximate_receive_count: run.delivery.approximate_receive_count,
          last_attempt_id: report.attempt_id,
        },
        [outcomeEventId],
      );
      if (exhausted.kind === 'stopped') {
        throw journalFault(invocation, 'inner_execution_exhausted', exhausted.reason);
      }
    }
    throw new StepAttemptFailed({
      lambda_request_id: invocation.lambda_request_id,
      durable_execution_arn: invocation.durable_execution_arn,
      step_attempt: invocation.step_attempt,
      attempt_id: report.attempt_id,
      outcome_class: disposition.failed_class,
    });
  }

  async #performAttempt(run: StepAttemptRun, message: TrialMessage): Promise<AttemptReport> {
    const client = this.#deps.openClient(run.journal, run.scope);
    try {
      return await client.performAttempt({
        caller_id: 'durable',
        refund_request_id: message.refund_request_id,
        payment_id: message.payment_id,
        amount_minor: this.#deps.refund.amount_minor,
        currency: this.#deps.refund.currency,
        provider_qualifier: this.#deps.provider_qualifier,
        causation_event_ids: [run.started_event_id],
      });
    } catch (error: unknown) {
      if (error instanceof AttemptNotRegisteredError) {
        throw new DurableCallerFault('ATTEMPT_NOT_REGISTERED', run.invocation.lambda_request_id, error.message);
      }
      throw error;
    }
  }
}

function deployedExecutionRef(deployment: DurableDeployment): TrialExecutionRef {
  return deployment.execution_kind === 'RUN'
    ? { field: 'run_id', id: deployment.run_id }
    : { field: 'variant_validation_id', id: deployment.variant_validation_id };
}

function processingUpdateOf(terminality: TerminalityDecision | DurableDefinitiveFinish): ProcessingUpdate {
  return terminality.processing_state === 'RUNNING'
    ? { processing_state: 'RUNNING' }
    : { processing_state: 'FINISHED', terminal_reason: terminality.terminal_reason };
}

function assertRecorded(result: RequestStateRecordResult, invocation: DurableInvocation, what: string): void {
  if (result.kind === 'not_recorded') {
    throw new DurableCallerFault(
      'STATE_NOT_RECORDED',
      invocation.lambda_request_id,
      `${what} not recorded: ${result.code}: ${result.detail}`,
    );
  }
}

function journalFault(invocation: DurableInvocation, eventType: string, reason: string): DurableCallerFault {
  return new DurableCallerFault('JOURNAL_STOPPED', invocation.lambda_request_id, `${eventType} not written: ${reason}`);
}
