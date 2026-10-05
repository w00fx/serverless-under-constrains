// Typed builders shared by the group-C examples. The identifiers, timestamps, digests and the
// kernel round trip come from the group-B builders, so all three catalogue groups describe one
// study run with the same execution, trial and manifest identities.

import type { EvidenceRef } from '../../../../../src/record-contract/evidence-refs.ts';
import type { JsonValue, StructuredReason } from '../../../../../src/record-contract/primitives.ts';
import type {
  ArtifactRef,
  ConditionResult,
  IndexEntry,
  SixConditionResults,
} from '../../../../../src/record-contract/records/group-c/shared-shapes.ts';
import { CONDITION_IDS } from '../../../../../src/record-contract/records/group-c/vocabulary.ts';
import type {
  ArtifactClass,
  ArtifactDerivation,
  ConditionId,
  PreservationVerdict,
} from '../../../../../src/record-contract/records/group-c/vocabulary.ts';
import { TRIAL_ID, digest, reason } from '../../group-b/support/record-builders.ts';

/** The trial directory of the shared trial (design §7 package layout). */
export const TRIAL_DIRECTORY = `trials/${TRIAL_ID}`;

/**
 * A reference to a package file whose digest is derived from its path.
 *
 * @example
 * artifactRef('cleanup/cleanup-result.json'); // { artifact_path, artifact_sha256 }
 */
export function artifactRef(path: string): ArtifactRef {
  return { artifact_path: path, artifact_sha256: digest(path) };
}

/**
 * An evidence reference (BR-RUA-035) to a package file, optionally to one event inside it or
 * (outside a package) with the package-index digest.
 *
 * @example
 * evidenceRef(`${TRIAL_DIRECTORY}/ledger-snapshot.json`);
 */
export function evidenceRef(
  path: string,
  member: Omit<EvidenceRef, 'artifact_path' | 'artifact_sha256'> = {},
): EvidenceRef {
  return { ...artifactRef(path), ...member };
}

/**
 * One index entry whose size and digest are derived from its path.
 *
 * @example
 * indexEntry('execution-manifest.json', 'execution_manifest');
 */
export function indexEntry(
  path: string,
  artifactClass: ArtifactClass,
  derivation: ArtifactDerivation = 'primary',
): IndexEntry {
  return {
    artifact_path: path,
    artifact_class: artifactClass,
    derivation,
    bytes: 64 * path.length,
    sha256: digest(path),
  };
}

/**
 * A structured reason whose code is narrowed to a closed vocabulary.
 *
 * @example
 * codedReason('UNINDEXED_FILE', 'package index'); // StructuredReason & { code: 'UNINDEXED_FILE' }
 */
export function codedReason<Code extends string>(code: Code, subject: string): StructuredReason & { code: Code } {
  return { ...reason(code, subject), code };
}

/**
 * One treatment condition result (BR-RUA-010..015). An indeterminate one states its reason.
 *
 * @example
 * conditionResult('BR-RUA-012', 'pass');
 */
export function conditionResult(conditionId: ConditionId, result: PreservationVerdict): ConditionResult {
  const expected: JsonValue = { condition: conditionId, holds: true };
  return {
    condition_id: conditionId,
    result,
    expected,
    // Free-form values are any non-null JSON (BR-RUA-033): missing evidence is stated, not null.
    observed: result === 'pass' ? expected : { condition: conditionId, holds: result === 'fail' ? false : 'unknown' },
    evidence_refs: result === 'indeterminate' ? [] : [evidenceRef(`${TRIAL_DIRECTORY}/provider-journal.jsonl`)],
    indeterminate_reasons: result === 'indeterminate' ? [reason('CONDITION_EVIDENCE_MISSING', conditionId)] : [],
    affected_by: result === 'indeterminate' ? ['SOURCE_SEQUENCE_GAP'] : [],
  };
}

/**
 * The six conditions in their fixed order; `exception` gives one condition another result.
 *
 * @example
 * sixConditions('pass', ['BR-RUA-013', 'indeterminate']);
 */
export function sixConditions(
  result: PreservationVerdict,
  exception?: readonly [ConditionId, PreservationVerdict],
): SixConditionResults {
  const resultOf = (id: ConditionId): PreservationVerdict => (exception?.[0] === id ? exception[1] : result);
  const [c10, c11, c12, c13, c14, c15] = CONDITION_IDS;
  return [
    conditionResult(c10, resultOf(c10)),
    conditionResult(c11, resultOf(c11)),
    conditionResult(c12, resultOf(c12)),
    conditionResult(c13, resultOf(c13)),
    conditionResult(c14, resultOf(c14)),
    conditionResult(c15, resultOf(c15)),
  ];
}
