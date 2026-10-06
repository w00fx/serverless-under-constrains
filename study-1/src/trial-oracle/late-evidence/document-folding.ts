// Folding a re-captured document into its frozen copy (BR-RUA-043, design §8.13 "ingests the frozen
// artifacts plus the late stream"). A ledger snapshot, DLQ snapshot or Durable execution listing
// taken after freeze contributes the items the frozen copy lacks: the reassessed document is the
// frozen one with those items appended, so every frozen member, the read's declared completeness
// and its consistency stay what was frozen. The ledger's last page counts the added items, so the
// pagination proof (design §8.2 I7) holds for the union exactly when it held for the frozen read.
// The frozen bytes themselves are never changed (AC-RUA-030): folding returns new bytes.

import { canonicalJson } from '../../record-contract/canonical-json.ts';
import { boundedJsonText } from '../../record-contract/json-value.ts';
import { parseJsonDocument } from '../../record-contract/parsing.ts';
import { err, ok } from '../../record-contract/primitives.ts';
import type { JsonObject, JsonValue, Result } from '../../record-contract/primitives.ts';
import type { RecordType } from '../../record-contract/record-types.ts';
import type { LedgerSnapshot } from '../../record-contract/records/group-b/ledger_snapshot.ts';
import type { RecordValidator } from '../../record-contract/schema-registry.ts';
import type { LateFold } from './late-record-routing.ts';

/** The folds that merge one document into another. */
export type DocumentFold = Exclude<LateFold, 'append_line'>;

interface FoldShape {
  readonly record_type: RecordType;
  /** The list member that holds the document's items. */
  readonly items: string;
}

const FOLD_SHAPES: Readonly<Record<DocumentFold, FoldShape>> = {
  ledger_transactions: { record_type: 'ledger_snapshot', items: 'transactions' },
  dlq_messages: { record_type: 'dlq_snapshot', items: 'messages' },
  durable_executions: { record_type: 'durable_execution_metadata', items: 'executions' },
};

const encoder = new TextEncoder();

/**
 * The bytes of the frozen document with the late document's new items folded in, or why the two
 * cannot be folded. With no frozen copy the late document stands alone; with nothing new the frozen
 * bytes are returned unchanged.
 *
 * @example
 * const folded = foldLateDocument('ledger_transactions', frozenLedgerBytes, lateLedger, validator);
 * if (folded.ok) folded.value; // the frozen ledger plus the late transactions, canonical JSON
 */
export function foldLateDocument(
  fold: DocumentFold,
  frozen: Uint8Array | undefined,
  late: JsonObject,
  validator: RecordValidator,
): Result<Uint8Array, string> {
  const shape = FOLD_SHAPES[fold];
  const lateItems = validItems(shape, late, validator, 'the late document');
  if (!lateItems.ok) {
    return lateItems;
  }
  if (frozen === undefined) {
    return ok(encoder.encode(`${canonicalJson(late)}\n`));
  }
  const parsed = parseJsonDocument(frozen);
  if (!parsed.ok) {
    return err(`the frozen document is unreadable (${parsed.error.kind}); expected one JSON ${shape.record_type}`);
  }
  const frozenItems = validItems(shape, parsed.value, validator, 'the frozen document');
  if (!frozenItems.ok) {
    return frozenItems;
  }
  const added = newItems(frozenItems.value.items, lateItems.value.items);
  if (added.length === 0) {
    return ok(frozen);
  }
  const document = frozenItems.value.document;
  const union = { ...document, [shape.items]: [...frozenItems.value.items, ...added] };
  const folded = fold === 'ledger_transactions' ? withLastPageCount(union, added.length) : union;
  return ok(encoder.encode(`${canonicalJson(folded)}\n`));
}

interface ValidDocument {
  readonly document: JsonObject;
  readonly items: readonly JsonValue[];
}

function validItems(
  shape: FoldShape,
  value: JsonValue,
  validator: RecordValidator,
  name: string,
): Result<ValidDocument, string> {
  const validation = validator.validateAs(shape.record_type, value);
  if (!validation.valid) {
    const why = validation.violations
      .slice(0, 1)
      .map((violation) => `${violation.instance_path} ${violation.detail}`)
      .join('');
    return err(`${name} is not a valid ${shape.record_type}: ${boundedJsonText(why)}`);
  }
  // The three schemas require the item member to be an array of objects.
  const document = validation.record as unknown as JsonObject;
  return ok({ document, items: document[shape.items] as readonly JsonValue[] });
}

// Late items the frozen list lacks, each once: a re-captured listing repeats what was frozen.
function newItems(frozen: readonly JsonValue[], late: readonly JsonValue[]): readonly JsonValue[] {
  const known = new Set(frozen.map((item) => canonicalJson(item)));
  const added: JsonValue[] = [];
  for (const item of late) {
    const key = canonicalJson(item);
    if (!known.has(key)) {
      known.add(key);
      added.push(item);
    }
  }
  return added;
}

// A snapshot without pages has no page to count the items in; its pagination stays unproven.
function withLastPageCount(ledger: JsonObject, added: number): JsonObject {
  const pages = (ledger as unknown as LedgerSnapshot).pages;
  const last = pages.at(-1);
  if (last === undefined) {
    return ledger;
  }
  const counted = { ...last, item_count: last.item_count + added };
  return { ...ledger, pages: [...pages.slice(0, -1), counted] as unknown as JsonValue };
}
