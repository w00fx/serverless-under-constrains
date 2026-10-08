// Which re-read records are late (BR-RUA-043; design §8.13, §10.4 step 1). After monitoring the
// collector re-reads every source a frozen unit was collected from; a record is late exactly when
// the frozen copy of its artifact does not already hold a record with the same identity:
// - a journal event by its `event_id` together with its source position (`source`,
//   `source_instance_id`, `source_sequence`, BR-RUA-033), so an event that reuses a frozen event id
//   or a frozen position with other content stays visible as late evidence instead of being hidden
//   as already known (BR-RUA-034 judges the conflict when the oracle re-ingests it);
// - a ledger transaction by its `provider_transaction_id`;
// - a dead-letter message by its SQS `message_id` (MessageId);
// - a Durable execution by its `durable_execution_arn`.
// An item that lacks its identity members is identified by its whole canonical content. Frozen
// bytes and re-read items are untrusted (Owner amendment A-05): only own members are read, parsing
// and canonical forms go through the kernel's iterative helpers, and nothing here throws.

import { canonicalJsonIfRepresentable } from '../record-contract/canonical-json.ts';
import { parseJsonDocument, parseJsonl } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonValue, Result } from '../record-contract/primitives.ts';
import { nonEmptyString, ownValue, safeCount } from './sdk-values.ts';

/** The kinds of re-read records whose identity decides lateness. */
export const LATE_ITEM_KINDS = ['journal_event', 'ledger_transaction', 'dlq_message', 'durable_execution'] as const;
export type LateItemKind = (typeof LATE_ITEM_KINDS)[number];

/** The kinds whose records are items of one re-captured document. */
export type DocumentItemKind = Exclude<LateItemKind, 'journal_event'>;

/** The list member of each re-captured document (ledger_snapshot, dlq_snapshot, durable_execution_metadata). */
export const DOCUMENT_ITEM_MEMBERS: Readonly<Record<DocumentItemKind, string>> = {
  ledger_transaction: 'transactions',
  dlq_message: 'messages',
  durable_execution: 'executions',
};

/** The identity member of each document item kind. */
const DOCUMENT_IDENTITY_MEMBERS: Readonly<Record<DocumentItemKind, string>> = {
  ledger_transaction: 'provider_transaction_id',
  dlq_message: 'message_id',
  durable_execution: 'durable_execution_arn',
};

// The key of an item that holds no value JSON can write; every such item shares it.
const UNREPRESENTABLE_KEY = '["unrepresentable"]';

/**
 * The identity key of one record of `kind`: its identity members, or its whole canonical content
 * when they are missing. Two records share a key exactly when they are the same record.
 *
 * @example
 * itemIdentity('ledger_transaction', { provider_transaction_id: 'b7…' }); // '["ledger_transaction","b7…"]'
 * itemIdentity('dlq_message', { body: 'x' }); // '["content",{"body":"x"}]'
 */
export function itemIdentity(kind: LateItemKind, item: unknown): string {
  const members = kind === 'journal_event' ? eventIdentity(item) : documentItemIdentity(kind, item);
  return canonicalJsonIfRepresentable(members ?? ['content', item]) ?? UNREPRESENTABLE_KEY;
}

/**
 * The identities of every record a frozen artifact holds, or why its bytes cannot be read: a
 * journal is JSONL with one event per line; any other kind is one document whose item list is
 * read.
 *
 * @example
 * const known = frozenIdentities('journal_event', frozenCallerJournalBytes);
 * if (known.ok) known.value.size; // the number of distinct frozen events
 */
export function frozenIdentities(kind: LateItemKind, bytes: Uint8Array): Result<ReadonlySet<string>, string> {
  const records = kind === 'journal_event' ? journalLines(bytes) : frozenDocumentItems(kind, bytes);
  return records.ok ? ok(new Set(records.value.map((record) => itemIdentity(kind, record)))) : records;
}

/**
 * The records whose identity is not in `known`, each identity once, in their read order.
 *
 * @example
 * absentItems('dlq_message', new Set([itemIdentity('dlq_message', frozenMessage)]), recaptured);
 */
export function absentItems<T>(kind: LateItemKind, known: ReadonlySet<string>, items: readonly T[]): readonly T[] {
  const seen = new Set(known);
  const absent: T[] = [];
  for (const item of items) {
    const key = itemIdentity(kind, item);
    if (!seen.has(key)) {
      seen.add(key);
      absent.push(item);
    }
  }
  return absent;
}

/**
 * The items of a document of `kind`: its own list member, or none when the document is not an
 * object holding that list.
 *
 * @example
 * documentItems('ledger_transaction', ledgerSnapshot); // the snapshot's transactions
 */
export function documentItems(kind: DocumentItemKind, document: unknown): readonly JsonValue[] {
  return listMember(kind, document) ?? [];
}

function eventIdentity(item: unknown): readonly JsonValue[] | undefined {
  const eventId = nonEmptyString(ownValue(item, 'event_id'));
  const source = nonEmptyString(ownValue(item, 'source'));
  const instance = nonEmptyString(ownValue(item, 'source_instance_id'));
  const sequence = safeCount(ownValue(item, 'source_sequence'), 1);
  if (eventId === undefined || source === undefined || instance === undefined || sequence === undefined) {
    return undefined;
  }
  return ['journal_event', eventId, source, instance, sequence];
}

function documentItemIdentity(kind: DocumentItemKind, item: unknown): readonly JsonValue[] | undefined {
  const identity = nonEmptyString(ownValue(item, DOCUMENT_IDENTITY_MEMBERS[kind]));
  return identity === undefined ? undefined : [kind, identity];
}

function journalLines(bytes: Uint8Array): Result<readonly JsonValue[], string> {
  const records: JsonValue[] = [];
  for (const line of parseJsonl(bytes).lines) {
    if (!line.parsed.ok) {
      return err(`line ${String(line.line_number)} is not one JSON value (${line.parsed.error.kind})`);
    }
    records.push(line.parsed.value);
  }
  return ok(records);
}

function frozenDocumentItems(kind: DocumentItemKind, bytes: Uint8Array): Result<readonly JsonValue[], string> {
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok) {
    return err(`is not one JSON document (${parsed.error.kind})`);
  }
  const items = listMember(kind, parsed.value);
  return items === undefined ? err(`holds no ${DOCUMENT_ITEM_MEMBERS[kind]} list`) : ok(items);
}

function listMember(kind: DocumentItemKind, document: unknown): readonly JsonValue[] | undefined {
  const items = ownValue(document, DOCUMENT_ITEM_MEMBERS[kind]);
  return Array.isArray(items) ? (items as readonly JsonValue[]) : undefined;
}
