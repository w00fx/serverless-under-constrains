// The variant-owned request state (design §5.3 `RequestStateRecorder`; the provider client
// leaves request state to the variant, C6). Each recording is one transaction: the
// `request_state_recorded` journal put (action 0) and the request-state item put, conditioned on
// the version it replaces (absent for version 1). The event therefore exists exactly when the
// state changed, versions stay dense from 1 (BR-RUA-004 reads them in order) and knowledge
// follows the BR-RUA-022 table from the stored state. The transaction token is the event id,
// fresh per event and resubmitted unchanged only as the BR-RUA-033 identical retry after a
// definitive failure.
//
// Shared with the Durable variant through the declared same-layer edge (design §5.4).

import { nextEffectKnowledge } from '../../attempt-lifecycle/effect-knowledge.ts';
import { INITIAL_EFFECT_KNOWLEDGE } from '../../attempt-lifecycle/effect-knowledge.ts';
import type { OutcomeClass } from '../../attempt-lifecycle/outcome-classification.ts';
import type { DurableItemStore, ItemKey, StoredItem, WriteAction } from '../../durable-store/item-store-port.ts';
import { journalPutAction } from '../../event-journal/journal-entry.ts';
import type { EventBody, JournalEvent } from '../../event-journal/journal-event.ts';
import { journalPartitionKey } from '../../event-journal/journal-scope.ts';
import type { JournalScope } from '../../event-journal/journal-scope.ts';
import type { JournalWriter, PreparedJournalPut } from '../../event-journal/journal-writer.ts';
import { boundedJsonText } from '../../record-contract/json-value.ts';
import type { Result, Uuid4 } from '../../record-contract/primitives.ts';
import { err, ok } from '../../record-contract/primitives.ts';
import type { ProcessingTerminalReason } from '../../record-contract/records/group-b/vocabulary.ts';
import { findOrphanAttempts } from './orphan-attempts.ts';
import type { OrphanAttempt } from './orphan-attempts.ts';
import {
  parseRequestStateItem,
  rejectedMessageStateKey,
  requestStateKey,
  toRequestStateItem,
} from './request-state-item.ts';
import type { RequestKey, RequestStateSnapshot } from './request-state-item.ts';

/** The table that holds caller events and caller state (design §9.3). */
const STATE_TABLE = 'caller_journal';

/** The journal put's index in every recording transaction. */
export const REQUEST_STATE_JOURNAL_ACTION_INDEX = 0;

export type ProcessingUpdate =
  | { readonly processing_state: 'RUNNING' }
  | {
      readonly processing_state: 'FINISHED';
      readonly terminal_reason: Exclude<ProcessingTerminalReason, 'MESSAGE_REJECTED'>;
    };

/** One finished attempt, as the request state accounts for it. */
export interface AccountedAttempt {
  readonly attempt_id: Uuid4;
  readonly outcome_class: OutcomeClass;
}

/** The rejected delivery a MESSAGE_REJECTED state answers. */
export interface RejectedDelivery {
  readonly message_id: string;
  /** The `trial_message_rejected` event. */
  readonly causation_event_ids: readonly Uuid4[];
}

export const REQUEST_STATE_FAILURE_CODES = [
  'STATE_UNREADABLE',
  'VERSION_CONFLICT',
  'REJECTED',
  'JOURNAL_STOPPED',
] as const;
export type RequestStateFailureCode = (typeof REQUEST_STATE_FAILURE_CODES)[number];

export interface RequestStateNotRecorded {
  readonly kind: 'not_recorded';
  readonly code: RequestStateFailureCode;
  readonly detail: string;
}

export type RequestStateRecordResult =
  | { readonly kind: 'recorded'; readonly event: JournalEvent; readonly state: RequestStateSnapshot }
  | { readonly kind: 'unchanged' }
  | RequestStateNotRecorded;

export interface RequestStateRecorderDeps {
  readonly store: DurableItemStore;
  /** The writer of the invocation's caller source instance. */
  readonly journal: JournalWriter;
  /** The trial partition the journal writes to. */
  readonly scope: JournalScope;
  /** Identical retries after a definitive failure, beyond the first try (BR-RUA-033). */
  readonly maxDefinitiveRetries: number;
}

type RequestStateBody = EventBody<'request_state_recorded'>;

/** The next state and the event body that records it. */
interface PlannedState {
  readonly snapshot: RequestStateSnapshot;
  readonly body: RequestStateBody;
}

export class RequestStateRecorder {
  readonly #deps: RequestStateRecorderDeps;
  readonly #partitionKey: string;

  constructor(deps: RequestStateRecorderDeps) {
    this.#deps = deps;
    this.#partitionKey = journalPartitionKey(deps.scope);
  }

  /**
   * Records the state after one attempt: its class folded into the stored knowledge, its id
   * appended, and the processing decision of the variant.
   *
   * @example
   * await recorder.recordAttemptResult({ refund_request_id }, { attempt_id, outcome_class: 'AMBIGUOUS' },
   *   { processing_state: 'RUNNING' }, [report.outcome_event_id]);
   */
  async recordAttemptResult(
    request: RequestKey,
    attempt: AccountedAttempt,
    processing: ProcessingUpdate,
    causation: readonly Uuid4[],
  ): Promise<RequestStateRecordResult> {
    const key = requestStateKey(this.#partitionKey, request);
    const current = await this.#read(key);
    if (!current.ok) {
      return current.error;
    }
    const planned = planState(current.value, [attempt], processing, request);
    return this.#record(key, current.value, planned, causation);
  }

  /**
   * Folds the request's orphan attempts into its state as RUNNING; `unchanged` when there are
   * none.
   *
   * @example
   * const reconciled = await recorder.reconcileOrphans({ refund_request_id }, [startedEventId]);
   */
  async reconcileOrphans(request: RequestKey, causation: readonly Uuid4[]): Promise<RequestStateRecordResult> {
    const key = requestStateKey(this.#partitionKey, request);
    const current = await this.#read(key);
    if (!current.ok) {
      return current.error;
    }
    const orphans = await this.#orphansOf(request, current.value);
    if (!orphans.ok) {
      return orphans.error;
    }
    if (orphans.value.length === 0) {
      return { kind: 'unchanged' };
    }
    const planned = planState(current.value, orphans.value, { processing_state: 'RUNNING' }, request);
    return this.#record(key, current.value, planned, causation);
  }

  /**
   * Records MESSAGE_REJECTED: processing finished, knowledge unchanged (NOT_ATTEMPTED for a new
   * request, AC-RUA-019). `request` is `undefined` when the body named no readable request.
   *
   * @example
   * await recorder.recordMessageRejected(undefined, { message_id, causation_event_ids: [rejectedEventId] });
   */
  async recordMessageRejected(
    request: RequestKey | undefined,
    rejected: RejectedDelivery,
  ): Promise<RequestStateRecordResult> {
    const key =
      request === undefined
        ? rejectedMessageStateKey(this.#partitionKey, rejected.message_id)
        : requestStateKey(this.#partitionKey, request);
    const current = await this.#read(key);
    if (!current.ok) {
      return current.error;
    }
    const base = baseOf(current.value, []);
    const planned: PlannedState = {
      snapshot: { ...base, processing_state: 'FINISHED' },
      body: {
        ...base,
        processing_state: 'FINISHED',
        processing_terminal_reason: 'MESSAGE_REJECTED',
        ...(request === undefined ? {} : { refund_request_id: request.refund_request_id }),
      },
    };
    return this.#record(key, current.value, planned, rejected.causation_event_ids);
  }

  async #read(key: ItemKey): Promise<Result<RequestStateSnapshot | undefined, RequestStateNotRecorded>> {
    const read = await this.#deps.store.getConsistent(STATE_TABLE, key);
    if (!read.ok) {
      return err(
        notRecorded('STATE_UNREADABLE', `request-state read of ${key.sk} failed: ${boundedJsonText(read.error.code)}`),
      );
    }
    if (read.value === undefined) {
      return ok(undefined);
    }
    const parsed = parseRequestStateItem(read.value);
    return parsed.ok ? parsed : err(notRecorded('STATE_UNREADABLE', parsed.error));
  }

  async #orphansOf(
    request: RequestKey,
    current: RequestStateSnapshot | undefined,
  ): Promise<Result<readonly OrphanAttempt[], RequestStateNotRecorded>> {
    const items = await this.#partitionItems();
    if (!items.ok) {
      return items;
    }
    const orphans = findOrphanAttempts(items.value, request.refund_request_id, new Set(current?.attempt_ids ?? []));
    return orphans.ok ? orphans : err(notRecorded('STATE_UNREADABLE', orphans.error));
  }

  async #partitionItems(): Promise<Result<readonly StoredItem[], RequestStateNotRecorded>> {
    const items: StoredItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#deps.store.queryPartitionPage(STATE_TABLE, this.#partitionKey, cursor);
      if (!page.ok) {
        return err(
          notRecorded(
            'STATE_UNREADABLE',
            `partition query of ${this.#partitionKey} failed: ${boundedJsonText(page.error.code)}`,
          ),
        );
      }
      items.push(...page.value.items);
      cursor = page.value.next_cursor;
    } while (cursor !== undefined);
    return ok(items);
  }

  // Writes the planned state with its event; a definitively refused transaction is resubmitted
  // unchanged within the retry budget, and every other refusal is reported, never re-planned.
  async #record(
    key: ItemKey,
    current: RequestStateSnapshot | undefined,
    planned: PlannedState,
    causation: readonly Uuid4[],
  ): Promise<RequestStateRecordResult> {
    const { journal, maxDefinitiveRetries } = this.#deps;
    let prepared = journal.prepare('request_state_recorded', planned.body, causation);
    for (let retry = 0; prepared.kind === 'prepared'; retry += 1) {
      const outcome = await this.#deps.store.transact(
        stateActions(prepared.put, key, current, planned.snapshot),
        prepared.put.event.event_id,
      );
      const confirmed = journal.confirm(prepared.put, outcome, REQUEST_STATE_JOURNAL_ACTION_INDEX);
      if (confirmed.kind === 'appended') {
        return { kind: 'recorded', event: confirmed.event, state: planned.snapshot };
      }
      if (confirmed.kind === 'stopped') {
        return notRecorded(
          'JOURNAL_STOPPED',
          `request_state_recorded v${String(planned.snapshot.version)} not written: ${confirmed.reason}: ${confirmed.detail}`,
        );
      }
      if (confirmed.outcome.kind !== 'definitive_failure') {
        return notRecorded(
          'VERSION_CONFLICT',
          `${key.sk} changed since version ${String(current?.version ?? 0)} was read; expected it unchanged until version ${String(planned.snapshot.version)} is written`,
        );
      }
      if (retry >= maxDefinitiveRetries) {
        return notRecorded(
          'REJECTED',
          `${key.sk} v${String(planned.snapshot.version)}: ${String(retry + 1)} identical transaction(s) refused definitively; last ${boundedJsonText(confirmed.outcome.code)}`,
        );
      }
      prepared = journal.prepareRetry(prepared.put);
    }
    return notRecorded(
      'JOURNAL_STOPPED',
      `request_state_recorded v${String(planned.snapshot.version)} not written: ${prepared.reason}: ${prepared.detail}`,
    );
  }
}

function stateActions(
  put: PreparedJournalPut,
  key: ItemKey,
  current: RequestStateSnapshot | undefined,
  next: RequestStateSnapshot,
): readonly WriteAction[] {
  const condition =
    current === undefined
      ? ({ kind: 'item_absent' } as const)
      : ({ kind: 'attribute_equals', name: 'version', value: current.version } as const);
  return [
    journalPutAction(STATE_TABLE, put),
    { kind: 'put', table: STATE_TABLE, item: toRequestStateItem(key, next), condition },
  ];
}

function baseOf(
  current: RequestStateSnapshot | undefined,
  attempts: readonly AccountedAttempt[],
): Omit<RequestStateSnapshot, 'processing_state'> {
  const from = current?.effect_knowledge ?? INITIAL_EFFECT_KNOWLEDGE;
  return {
    version: (current?.version ?? 0) + 1,
    effect_knowledge: attempts.reduce(
      (knowledge, attempt) => nextEffectKnowledge(knowledge, attempt.outcome_class),
      from,
    ),
    attempt_ids: [...(current?.attempt_ids ?? []), ...attempts.map((attempt) => attempt.attempt_id)],
  };
}

function planState(
  current: RequestStateSnapshot | undefined,
  attempts: readonly AccountedAttempt[],
  processing: ProcessingUpdate,
  request: RequestKey,
): PlannedState {
  const base = baseOf(current, attempts);
  const snapshot = { ...base, processing_state: processing.processing_state };
  const body: RequestStateBody =
    processing.processing_state === 'RUNNING'
      ? { ...base, processing_state: 'RUNNING', refund_request_id: request.refund_request_id }
      : {
          ...base,
          processing_state: 'FINISHED',
          processing_terminal_reason: processing.terminal_reason,
          refund_request_id: request.refund_request_id,
        };
  return { snapshot, body };
}

function notRecorded(code: RequestStateFailureCode, detail: string): RequestStateNotRecorded {
  return { kind: 'not_recorded', code, detail };
}
