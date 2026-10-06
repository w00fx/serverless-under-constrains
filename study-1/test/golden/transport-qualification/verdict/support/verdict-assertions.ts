// The checks every probe-verdict golden makes besides its case's expectation: the built result is a
// valid `transport_probe_result` (CTR-RUA-003; the schema holds the BR-RUA-027 precedence and the
// fidelity rules) and every condition's references follow BR-RUA-035.

import assert from 'node:assert/strict';

import { validateEvidenceRefList, validateResultReferences } from '../../../../../src/record-contract/evidence-refs.ts';
import type { JsonValue } from '../../../../../src/record-contract/primitives.ts';
import type { TransportProbeResult } from '../../../../../src/record-contract/records/group-c/transport_probe_result.ts';
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
  assertWellFormed(result);
  return result;
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
