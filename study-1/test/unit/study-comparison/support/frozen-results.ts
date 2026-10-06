// The clean run's frozen oracle results as the comparison reads them, and edits of one result: each
// edit returns a new frozen record with the same reference, as a test of the derivation (not of
// reading) needs.

import type { GateValue, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import type { OracleResult } from '../../../../src/record-contract/records/group-c/oracle_result.ts';
import type { FrozenRecord } from '../../../../src/study-comparison/record-files.ts';
import type { OracleResultsByTrial } from '../../../../src/study-comparison/run-evidence-integrity.ts';
import type { RunPackageRecords } from '../../../../src/study-comparison/run-package-reader.ts';

/**
 * The frozen oracle results of a run, by trial id.
 *
 * @example
 * resultsOf(records).size; // 4 for the clean run
 */
export function resultsOf(records: RunPackageRecords): Map<Uuid4, FrozenRecord<OracleResult>> {
  return new Map(
    records.trial_records.flatMap((trial) =>
      trial.oracle_result === undefined ? [] : [[trial.trial.trial_id, trial.oracle_result] as const],
    ),
  );
}

/**
 * The results with one trial's result replaced by an edit of it, or removed when `edit` is null.
 *
 * @example
 * editResult(results, trialId, (record) => ({ ...record, trial_validity: 'invalid' }));
 */
export function editResult(
  results: OracleResultsByTrial,
  trialId: Uuid4,
  edit: ((record: OracleResult) => OracleResult) | null,
): Map<Uuid4, FrozenRecord<OracleResult>> {
  const copy = new Map(results);
  const frozen = copy.get(trialId);
  if (frozen === undefined) {
    throw new Error(`trial ${trialId} has no result; expected one of ${[...copy.keys()].join(', ')}`);
  }
  if (edit === null) {
    copy.delete(trialId);
    return copy;
  }
  return copy.set(trialId, { ...frozen, record: edit(frozen.record) });
}

/**
 * The record with its G8 `evidence_integrity` gate (the ninth) set to `value`.
 *
 * @example
 * withEvidenceGate(record, 'invalid').validity_gates[8].value; // 'invalid'
 */
export function withEvidenceGate(record: OracleResult, value: GateValue): OracleResult {
  const [g1, g2, g3, g4a, g4b, g5, g6, g7, g8] = record.validity_gates;
  return { ...record, validity_gates: [g1, g2, g3, g4a, g4b, g5, g6, g7, { ...g8, value }] };
}
