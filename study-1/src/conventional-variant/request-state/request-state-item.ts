// The request-state item of the caller journal (design §9.3): `state#request#<refund_request_id>`
// in the trial partition, next to the caller events, holding the current version of the
// logical request's state and the ids of every attempt it has accounted for. Each
// `request_state_recorded` event is written in one transaction with the item, conditioned on the
// version it replaces, so the recorded versions stay dense from 1 (BR-RUA-004 reads them in
// version order) and no attempt is counted twice.
//
// A rejected message whose body names no readable `refund_request_id` has no request to key by,
// so its state lives under `state#rejected-message#<message_id>` (WP-20 decision log row 6).
//
// The item is read back from the store, so it is checked before use: a damaged item stops the
// recording instead of extending a wrong history.

import { isUuid4 } from '../../record-contract/identifiers.ts';
import { describeJson, findDuplicateItems, isJsonArray } from '../../record-contract/json-value.ts';
import type { ItemKey, StoredItem } from '../../durable-store/item-store-port.ts';
import type { JsonValue, Result, Uuid4 } from '../../record-contract/primitives.ts';
import { err, ok } from '../../record-contract/primitives.ts';
import { EFFECT_KNOWLEDGE_STATES, PROCESSING_STATES } from '../../record-contract/records/group-b/vocabulary.ts';
import type { EffectKnowledge, ProcessingState } from '../../record-contract/records/group-b/vocabulary.ts';
import { ownField, unexpectedField } from '../../trial-message/trial-message-fields.ts';

export const REQUEST_STATE_SK_PREFIX = 'state#request#';
export const REJECTED_MESSAGE_STATE_SK_PREFIX = 'state#rejected-message#';

/** The logical request a state belongs to (BR-RUA-003 business identity). */
export interface RequestKey {
  readonly refund_request_id: string;
}

/** The current state of a request, as its item stores it. */
export interface RequestStateSnapshot {
  readonly version: number;
  readonly effect_knowledge: EffectKnowledge;
  readonly attempt_ids: readonly Uuid4[];
  readonly processing_state: ProcessingState;
}

const ITEM_FIELDS: ReadonlySet<string> = new Set([
  'pk',
  'sk',
  'version',
  'effect_knowledge',
  'attempt_ids',
  'processing_state',
]);

/**
 * The item key of a request's state in a trial partition.
 *
 * @example
 * requestStateKey(pk, { refund_request_id: 'ref-poc-001' }); // { pk, sk: 'state#request#ref-poc-001' }
 */
export function requestStateKey(partitionKey: string, request: RequestKey): ItemKey {
  return { pk: partitionKey, sk: `${REQUEST_STATE_SK_PREFIX}${request.refund_request_id}` };
}

/**
 * The item key of the state of a rejected message that names no readable request.
 *
 * @example
 * rejectedMessageStateKey(pk, 'msg-1').sk; // 'state#rejected-message#msg-1'
 */
export function rejectedMessageStateKey(partitionKey: string, messageId: string): ItemKey {
  return { pk: partitionKey, sk: `${REJECTED_MESSAGE_STATE_SK_PREFIX}${messageId}` };
}

/**
 * The stored item of a snapshot under `key`.
 *
 * @example
 * store.transact([journalPut, { kind: 'put', table: 'caller_journal', item: toRequestStateItem(key, next) }], token);
 */
export function toRequestStateItem(key: ItemKey, snapshot: RequestStateSnapshot): StoredItem {
  return {
    pk: key.pk,
    sk: key.sk,
    version: snapshot.version,
    effect_knowledge: snapshot.effect_knowledge,
    attempt_ids: [...snapshot.attempt_ids],
    processing_state: snapshot.processing_state,
  };
}

/**
 * Reads a stored request-state item; the failure names the first offending attribute.
 *
 * @example
 * const current = parseRequestStateItem(item);
 * if (current.ok) current.value.version;
 */
export function parseRequestStateItem(item: StoredItem): Result<RequestStateSnapshot, string> {
  const extra = unexpectedField(item, ITEM_FIELDS);
  if (extra !== undefined) {
    return err(
      `request-state item ${item.sk} has the unexpected attribute ${describeJson(extra)}; expected only ${[...ITEM_FIELDS].join(', ')}`,
    );
  }
  const version = ownField(item, 'version');
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return err(`request-state item ${item.sk} version ${describeJson(version)}; expected a positive safe integer`);
  }
  const knowledge = ownField(item, 'effect_knowledge');
  if (!isOneOf(EFFECT_KNOWLEDGE_STATES, knowledge)) {
    return err(
      `request-state item ${item.sk} effect_knowledge ${describeJson(knowledge)}; expected one of ${EFFECT_KNOWLEDGE_STATES.join(', ')}`,
    );
  }
  const processing = ownField(item, 'processing_state');
  if (!isOneOf(PROCESSING_STATES, processing)) {
    return err(
      `request-state item ${item.sk} processing_state ${describeJson(processing)}; expected one of ${PROCESSING_STATES.join(', ')}`,
    );
  }
  const attemptIds = ownField(item, 'attempt_ids');
  if (!isAttemptIdList(attemptIds)) {
    return err(
      `request-state item ${item.sk} attempt_ids ${describeJson(attemptIds)}; expected unique lowercase UUIDv4 values`,
    );
  }
  return ok({ version, effect_knowledge: knowledge, attempt_ids: attemptIds, processing_state: processing });
}

/**
 * Whether a stored value is one of a closed vocabulary.
 *
 * @example
 * isOneOf(PROCESSING_STATES, item['processing_state']); // true for 'RUNNING'
 */
export function isOneOf<T extends string>(values: readonly T[], value: JsonValue | undefined): value is T {
  return values.some((member) => member === value);
}

function isAttemptIdList(value: JsonValue | undefined): value is readonly Uuid4[] {
  return isJsonArray(value) && value.every(isUuid4) && findDuplicateItems(value) === undefined;
}
