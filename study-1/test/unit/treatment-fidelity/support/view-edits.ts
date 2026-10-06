// Edits of a real treatment view for the branches no ingested evidence can reach (a value the
// schemas already exclude, or an absence the builder cannot state alone), plus the shared checks of
// a condition result. Every edit starts from a view bound over ingested evidence, so only the named
// member differs from what production code sees.

import assert from 'node:assert/strict';

import type { IndexedEvent } from '../../../../src/evidence-ingestion/ingestion-model.ts';
import { validateEvidenceRefList, validateResultReferences } from '../../../../src/record-contract/evidence-refs.ts';
import type { JsonValue, StructuredReason } from '../../../../src/record-contract/primitives.ts';
import type { ConditionResult } from '../../../../src/record-contract/records/group-c/shared-shapes.ts';

/**
 * A copy of an event whose record has `patch` applied; the patch may break what the schema
 * guarantees, which is what a totality branch needs.
 *
 * @example
 * withRecord(view.caller_timeout, { elapsed_ns: 'three' });
 */
export function withRecord<E extends IndexedEvent>(event: E, patch: Readonly<Record<string, JsonValue>>): E {
  return { ...event, record: { ...event.record, ...patch } };
}

/**
 * The codes of reasons, in order.
 *
 * @example
 * codes(condition.indeterminate_reasons); // ['EVENT_MISSING']
 */
export function codes(reasons: readonly StructuredReason[]): readonly string[] {
  return reasons.map((reason) => reason.code);
}

/**
 * Asserts a condition result follows BR-RUA-035 and the shared condition rules: canonical
 * references, at least one reference when conclusive, reasons only when indeterminate.
 *
 * @example
 * assertWellFormedCondition(evaluateCausalJoin(view));
 */
export function assertWellFormedCondition(condition: ConditionResult): void {
  assert.deepEqual(
    validateResultReferences(condition.result, condition.evidence_refs, condition.indeterminate_reasons),
    [],
  );
  assert.deepEqual(validateEvidenceRefList(condition as unknown as JsonValue, 'evidence_refs', 'inside_package'), []);
  assert.equal(condition.indeterminate_reasons.length > 0, condition.result === 'indeterminate');
}

/**
 * `value` when the fixture holds it; a test whose fixture lacks the member fails here, naming it,
 * instead of reading through an undefined.
 *
 * @example
 * present(view.caller_timeout, 'the caller timeout');
 */
export function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`the fixture has no ${what}; expected the probe fixture to carry it`);
  }
  return value;
}
