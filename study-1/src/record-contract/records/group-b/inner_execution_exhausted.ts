// Catalogue group B row 28 (design §6.2): the inner durable execution exhausted its step
// attempts; not request-level exhaustion while the source can redeliver (BR-RUA-024).

import type { EventEnvelope } from '../../envelope.ts';
import type { Uuid4 } from '../../primitives.ts';

/** Schema: `schemas/group-b/inner_execution_exhausted.schema.json`. */
export interface InnerExecutionExhausted extends EventEnvelope<'inner_execution_exhausted'> {
  readonly source: 'durable_caller';
  readonly refund_request_id: string;
  readonly durable_execution_arn: string;
  readonly step_attempts: number;
  readonly approximate_receive_count: number;
  readonly last_attempt_id?: Uuid4;
}
