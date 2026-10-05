// Catalogue group B row 27 (design §6.2): one versioned transition of the logical request
// state (BR-RUA-022, BR-RUA-024, BR-RUA-004).

import type { EventEnvelope } from '../../envelope.ts';
import type { Uuid4 } from '../../primitives.ts';
import type { CallerEventSource, EffectKnowledge, ProcessingTerminalReason } from './vocabulary.ts';

interface RequestStateBase extends EventEnvelope<'request_state_recorded'> {
  readonly source: CallerEventSource;
  /** Dense from 1 per request; BR-RUA-004 reads the states in version order. */
  readonly version: number;
  readonly effect_knowledge: EffectKnowledge;
  readonly attempt_ids: readonly Uuid4[];
}

/** Processing has not finished, so there is no terminal reason yet. */
export interface OpenRequestState extends RequestStateBase {
  readonly processing_state: 'NOT_STARTED' | 'RUNNING';
  readonly refund_request_id: string;
}

/** Processing finished with a terminal reason. */
export interface FinishedRequestState extends RequestStateBase {
  readonly processing_state: 'FINISHED';
  readonly processing_terminal_reason: Exclude<ProcessingTerminalReason, 'MESSAGE_REJECTED'>;
  readonly refund_request_id: string;
}

/** The message was rejected; its request identity may have been unreadable. */
export interface MessageRejectedRequestState extends RequestStateBase {
  readonly processing_state: 'FINISHED';
  readonly processing_terminal_reason: 'MESSAGE_REJECTED';
  readonly refund_request_id?: string;
}

/** Schema: `schemas/group-b/request_state_recorded.schema.json`. */
export type RequestStateRecorded = OpenRequestState | FinishedRequestState | MessageRejectedRequestState;
