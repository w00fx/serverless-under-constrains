// What a Durable step attempt throws, so the durable SDK applies the step retry strategy
// (BR-RUA-020: one initial step attempt plus one explicit step retry), and, once the step is
// exhausted, the execution fails and the event source mapping keeps the message, which SQS
// redelivers after the visibility timeout (a new execution) or moves to the DLQ.
//
// - `StepAttemptFailed`: the provider attempt was ambiguous or failed before dispatch, and the
//   request state already records it; the failure is the Durable retry path itself.
// - `DurableCallerFault`: the caller cannot do its work without breaking its evidence: the event
//   is no single SQS delivery, the registry names no usable trial (no trial partition can be
//   journaled without its digest), the journal stopped, an attempt could not be registered, or
//   the request state could not be recorded.

import type { Uuid4 } from '../record-contract/primitives.ts';
import type { FailedStepClass } from './durable-disposition.ts';

export const DURABLE_FAULT_CODES = [
  'DELIVERY_INVALID',
  'REGISTRY_UNREADABLE',
  'NO_ACTIVE_TRIAL',
  'REGISTRATION_MISMATCH',
  'JOURNAL_STOPPED',
  'ATTEMPT_NOT_REGISTERED',
  'STATE_NOT_RECORDED',
] as const;
export type DurableFaultCode = (typeof DURABLE_FAULT_CODES)[number];

/** The error name the step throws for a failed provider attempt. */
export const STEP_ATTEMPT_FAILED_ERROR_NAME = 'StepAttemptFailed';

/** The JSON log line of a fault (structured logging, clean-code rule). */
export interface DurableFaultLog {
  readonly level: 'error';
  readonly event: 'durable_caller_fault';
  readonly code: DurableFaultCode;
  readonly lambda_request_id: string;
  readonly detail: string;
}

export class DurableCallerFault extends Error {
  readonly code: DurableFaultCode;
  readonly lambdaRequestId: string;

  /**
   * @example
   * throw new DurableCallerFault('NO_ACTIVE_TRIAL', requestId, 'no registry item for durable');
   */
  constructor(code: DurableFaultCode, lambdaRequestId: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'DurableCallerFault';
    this.code = code;
    this.lambdaRequestId = lambdaRequestId;
  }

  /**
   * The structured log line the handler writes before it rethrows.
   *
   * @example
   * log.write(fault.toLog());
   */
  toLog(): DurableFaultLog {
    return {
      level: 'error',
      event: 'durable_caller_fault',
      code: this.code,
      lambda_request_id: this.lambdaRequestId,
      detail: this.message,
    };
  }
}

/** The step attempt that failed, as its log line names it. */
export interface FailedStepAttempt {
  readonly lambda_request_id: string;
  readonly durable_execution_arn: string;
  readonly step_attempt: number;
  readonly attempt_id: Uuid4;
  readonly outcome_class: FailedStepClass;
}

/** The JSON log line of a failed step attempt. */
export interface StepAttemptFailedLog extends FailedStepAttempt {
  readonly level: 'warn';
  readonly event: 'durable_step_attempt_failed';
}

export class StepAttemptFailed extends Error {
  readonly failed: FailedStepAttempt;

  /**
   * @example
   * throw new StepAttemptFailed({ lambda_request_id, durable_execution_arn, step_attempt: 1,
   *   attempt_id, outcome_class: 'AMBIGUOUS' });
   */
  constructor(failed: FailedStepAttempt) {
    super(
      `step attempt ${String(failed.step_attempt)} of ${failed.durable_execution_arn} ended ${failed.outcome_class} (attempt ${failed.attempt_id}); the step retry strategy decides what follows`,
    );
    this.name = STEP_ATTEMPT_FAILED_ERROR_NAME;
    this.failed = failed;
  }

  /**
   * The structured log line the handler writes before it rethrows.
   *
   * @example
   * log.write(failure.toLog());
   */
  toLog(): StepAttemptFailedLog {
    return { level: 'warn', event: 'durable_step_attempt_failed', ...this.failed };
  }
}
