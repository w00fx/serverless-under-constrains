// The shape every group-B example shares, so generic AC-RUA-046 checks can run over all of
// them: a typed record, the top-level members whose single removal keeps it valid, and the
// members the catalogue copies verbatim from untrusted input (any string is valid there).

import type { GroupBRecord } from '../../../../../src/record-contract/records/group-b/record-map.ts';

export interface RecordExample {
  /** `record_type`, plus the variant when one record type has several examples. */
  readonly label: string;
  readonly record: GroupBRecord;
  /** Top-level members that may be omitted on their own (absent, never null). */
  readonly optional: readonly string[];
  /** Top-level members typed as an unconstrained string (verbatim copies of rejected input). */
  readonly verbatim: readonly string[];
}

/**
 * Builds an example; `optional` and `verbatim` default to none.
 *
 * @example
 * example('dispatch_started', dispatchStarted(), { optional: ['causation_event_ids'] });
 */
export function example(
  label: string,
  record: GroupBRecord,
  members: { readonly optional?: readonly string[]; readonly verbatim?: readonly string[] } = {},
): RecordExample {
  return { label, record, optional: members.optional ?? [], verbatim: members.verbatim ?? [] };
}
