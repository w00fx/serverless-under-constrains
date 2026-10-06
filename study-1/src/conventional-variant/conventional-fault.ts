// What the conventional caller throws, so the event source mapping keeps the message and SQS
// delivers it again after the visibility timeout (BR-RUA-020), until the redrive policy moves it
// to the DLQ, which the collector captures as terminal evidence (design §8.7).
//
// - `DeliveryFailurePropagated`: the attempt was ambiguous or failed before dispatch, and the
//   request state already records it; the failure is the conventional retry path itself.
// - `ConventionalCallerFault`: the caller cannot do its work without breaking its evidence: the
//   event is no single SQS delivery, the registry names no usable trial (no trial partition can
//   be journaled without its digest), the journal stopped, an attempt could not be registered,
//   or the request state could not be recorded.

import { DELIVERY_FAILURE_ERROR_NAME } from './conventional-disposition.ts';

export const CONVENTIONAL_FAULT_CODES = [
  'DELIVERY_INVALID',
  'REGISTRY_UNREADABLE',
  'NO_ACTIVE_TRIAL',
  'REGISTRATION_MISMATCH',
  'JOURNAL_STOPPED',
  'ATTEMPT_NOT_REGISTERED',
  'STATE_NOT_RECORDED',
] as const;
export type ConventionalFaultCode = (typeof CONVENTIONAL_FAULT_CODES)[number];

/** The JSON log line of a fault (structured logging, clean-code rule). */
export interface ConventionalFaultLog {
  readonly level: 'error';
  readonly event: 'conventional_caller_fault';
  readonly code: ConventionalFaultCode;
  readonly lambda_request_id: string;
  readonly detail: string;
}

export class ConventionalCallerFault extends Error {
  readonly code: ConventionalFaultCode;
  readonly lambdaRequestId: string;

  /**
   * @example
   * throw new ConventionalCallerFault('NO_ACTIVE_TRIAL', requestId, 'no registry item for conventional');
   */
  constructor(code: ConventionalFaultCode, lambdaRequestId: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ConventionalCallerFault';
    this.code = code;
    this.lambdaRequestId = lambdaRequestId;
  }

  /**
   * The structured log line the handler writes before it rethrows.
   *
   * @example
   * process.stderr.write(`${JSON.stringify(fault.toLog())}\n`);
   */
  toLog(): ConventionalFaultLog {
    return {
      level: 'error',
      event: 'conventional_caller_fault',
      code: this.code,
      lambda_request_id: this.lambdaRequestId,
      detail: this.message,
    };
  }
}

/** The JSON log line of a propagated delivery failure. */
export interface DeliveryFailureLog {
  readonly level: 'warn';
  readonly event: 'conventional_delivery_failed';
  readonly lambda_request_id: string;
  readonly message_id: string;
  readonly approximate_receive_count: number;
}

export class DeliveryFailurePropagated extends Error {
  readonly lambdaRequestId: string;
  readonly messageId: string;
  readonly approximateReceiveCount: number;

  /**
   * @example
   * throw new DeliveryFailurePropagated(requestId, delivery.message_id, delivery.approximate_receive_count);
   */
  constructor(lambdaRequestId: string, messageId: string, approximateReceiveCount: number) {
    super(
      `delivery ${messageId} (receive ${String(approximateReceiveCount)}) failed; the message returns after the visibility timeout`,
    );
    this.name = DELIVERY_FAILURE_ERROR_NAME;
    this.lambdaRequestId = lambdaRequestId;
    this.messageId = messageId;
    this.approximateReceiveCount = approximateReceiveCount;
  }

  /**
   * The structured log line the handler writes before it throws.
   *
   * @example
   * process.stderr.write(`${JSON.stringify(failure.toLog())}\n`);
   */
  toLog(): DeliveryFailureLog {
    return {
      level: 'warn',
      event: 'conventional_delivery_failed',
      lambda_request_id: this.lambdaRequestId,
      message_id: this.messageId,
      approximate_receive_count: this.approximateReceiveCount,
    };
  }
}
