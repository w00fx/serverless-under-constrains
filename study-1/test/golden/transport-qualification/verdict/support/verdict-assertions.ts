// The checks every probe-verdict golden makes besides its case's expectation: every rule outcome the
// case declares it reaches is the one the result holds (a condition's result, or the BR-RUA-027
// verdict), the built result is a valid `transport_probe_result` (CTR-RUA-003; the schema holds the
// BR-RUA-027 precedence and the fidelity rules) and every condition's references follow BR-RUA-035.

import assert from 'node:assert/strict';

import { validateEvidenceRefList, validateResultReferences } from '../../../../../src/record-contract/evidence-refs.ts';
import type { JsonValue } from '../../../../../src/record-contract/primitives.ts';
import type { TransportProbeResult } from '../../../../../src/record-contract/records/group-c/transport_probe_result.ts';
import type { RuleOutcomeReached } from '../../../../support/golden-builder/golden-case.ts';
import { expectedMismatches } from '../../../_harness/golden-harness.ts';
import { frozenProbeResult, GOLDEN_VALIDATOR, loadProbeCase, resultProjection } from './probe-golden.ts';

/**
 * Builds the case's probe result and asserts its expectation, its schema and its references.
 *
 * @example
 * await assertVerdictCase('br010-reversed-timestamps');
 */
export async function assertVerdictCase(caseId: string): Promise<TransportProbeResult> {
  const loaded = await loadProbeCase(caseId);
  const result = frozenProbeResult(loaded.files);
  assert.deepEqual(expectedMismatches(loaded.golden_case.expected, resultProjection(result)), []);
  assertOutcomesReached(loaded.golden_case.rule_outcomes_reached, result);
  assertWellFormed(result);
  return result;
}

/**
 * Asserts the result reaches every declared rule outcome: a condition id names its condition's
 * result, BR-RUA-027 the probe verdict. A declared rule the result does not judge is a mismatch.
 *
 * @example
 * assertOutcomesReached([{ rule_id: 'BR-RUA-027', outcome: 'pass' }], result);
 */
export function assertOutcomesReached(declared: readonly RuleOutcomeReached[], result: TransportProbeResult): void {
  const reached = new Map<string, string>([
    ...result.condition_results.map((condition) => [condition.condition_id, condition.result] as const),
    ['BR-RUA-027', result.transport_probe_verdict],
  ]);
  const mismatches = declared
    .filter((rule) => reached.get(rule.rule_id) !== rule.outcome)
    .map((rule) => `${rule.rule_id} reached ${reached.get(rule.rule_id) ?? 'nothing'}; declared ${rule.outcome}`);
  assert.deepEqual(mismatches, []);
}

/**
 * Asserts the result is schema-valid with BR-RUA-035 references.
 *
 * @example
 * assertWellFormed(result);
 */
export function assertWellFormed(result: TransportProbeResult): void {
  const validation = GOLDEN_VALIDATOR.validateAs('transport_probe_result', result as unknown as JsonValue);
  assert.equal(validation.valid, true, JSON.stringify(validation.valid ? [] : validation.violations));
  for (const condition of result.condition_results) {
    assert.deepEqual(
      validateResultReferences(condition.result, condition.evidence_refs, condition.indeterminate_reasons),
      [],
    );
    assert.deepEqual(validateEvidenceRefList(condition as unknown as JsonValue, 'evidence_refs', 'inside_package'), []);
  }
  assert.deepEqual(validateEvidenceRefList(result as unknown as JsonValue, 'evidence_refs', 'inside_package'), []);
}
