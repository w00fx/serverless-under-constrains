// How a reassessed result differs from the frozen one on its verdict projection (D-16): the
// verdict, the validity, every gate value, every rule outcome and `correct_completion`. Each
// difference is named by its JSON Pointer into the oracle result, so a reader can find both values
// in the two result files (catalogue group C row 78 `changes[].field`).

import type { JsonValue } from '../../record-contract/primitives.ts';
import type { ProjectionChange } from '../../record-contract/records/group-c/late_evidence_assessment.ts';
import type { VerdictProjection } from '../verdict-projection.ts';

/**
 * Every projection field whose value differs, the frozen result's fields first in result order,
 * then any field only the reassessed result has. A field one side lacks reads as `null`.
 *
 * @example
 * projectionChanges(frozenPass, reassessedFail);
 * // [{ field: '/preservation_verdict', frozen: 'pass', reassessed: 'fail' }, ...]
 */
export function projectionChanges(
  frozen: VerdictProjection,
  reassessed: VerdictProjection,
): readonly ProjectionChange[] {
  const before = projectionFields(frozen);
  const after = projectionFields(reassessed);
  const fields = [...new Set([...before.keys(), ...after.keys()])];
  return fields.flatMap((field) => {
    const frozenValue = before.get(field) ?? null;
    const reassessedValue = after.get(field) ?? null;
    return frozenValue === reassessedValue ? [] : [{ field, frozen: frozenValue, reassessed: reassessedValue }];
  });
}

// Every projected value is a string, a boolean or null, so `===` compares them exactly.
function projectionFields(projection: VerdictProjection): ReadonlyMap<string, JsonValue> {
  const fields = new Map<string, JsonValue>([
    ['/preservation_verdict', projection.preservation_verdict],
    ['/trial_validity', projection.trial_validity],
  ]);
  projection.gates.forEach((gate, index) => {
    fields.set(`/validity_gates/${String(index)}/gate`, gate.gate);
    fields.set(`/validity_gates/${String(index)}/value`, gate.value);
  });
  projection.rules.forEach((rule, index) => {
    fields.set(`/rule_results/${String(index)}/rule_id`, rule.rule_id);
    fields.set(`/rule_results/${String(index)}/result`, rule.result);
  });
  fields.set('/correct_completion', projection.correct_completion);
  return fields;
}
