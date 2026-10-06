// What the journal-based rules BR-RUA-003 and BR-RUA-004 cite when the caller journal they read is
// gapped or unreadable: the journal itself, so an indeterminate result with an ARTIFACT_INCOMPLETE
// reason always names existing evidence (BR-RUA-035). An absent journal adds nothing; its
// ARTIFACT_MISSING reason already names the path.

import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import { canonicalRefs } from '../treatment-fidelity/condition-result.ts';

/**
 * References plus the caller journal's, when it was given, in canonical order.
 *
 * @example
 * withCaller([], callerState.ref); // [callerRef] for a gapped journal
 */
export function withCaller(refs: readonly EvidenceRef[], callerRef: EvidenceRef | undefined): readonly EvidenceRef[] {
  return callerRef === undefined ? refs : canonicalRefs([...refs, callerRef]);
}
