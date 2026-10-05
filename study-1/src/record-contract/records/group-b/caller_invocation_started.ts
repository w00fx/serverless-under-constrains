// Catalogue group B row 19 (design §6.2): one caller handler invocation began
// (BR-RUA-020, BR-RUA-024, BR-RUA-027 cardinality).

import type { EventEnvelope } from '../../envelope.ts';

interface InvocationBase extends EventEnvelope<'caller_invocation_started'> {
  /** Lambda request id; cross-checks the runner's `probe_workload_invoked` for the probe. */
  readonly lambda_request_id: string;
}

/** A conventional delivery: the SQS message and its ApproximateReceiveCount. */
export interface ConventionalInvocationStarted extends InvocationBase {
  readonly source: 'conventional_caller';
  readonly message_id: string;
  readonly approximate_receive_count: number;
}

/** A Durable invocation: the SQS delivery plus the durable execution it runs in. */
export interface DurableInvocationStarted extends InvocationBase {
  readonly source: 'durable_caller';
  readonly message_id: string;
  readonly approximate_receive_count: number;
  readonly durable_execution_arn: string;
  readonly step_attempt?: number;
}

/** The single synchronous probe invocation: no queue and no durable execution. */
export interface ProbeInvocationStarted extends InvocationBase {
  readonly source: 'probe_caller';
}

/** Schema: `schemas/group-b/caller_invocation_started.schema.json`. */
export type CallerInvocationStarted = ConventionalInvocationStarted | DurableInvocationStarted | ProbeInvocationStarted;
