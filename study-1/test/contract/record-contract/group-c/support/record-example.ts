// The shape every group-C example shares, so the catalogue-wide AC-RUA-046 checks can run over
// all of them: a typed record plus the top-level members whose single removal keeps it valid.

import type { GroupCRecord } from '../../../../../src/record-contract/records/group-c/record-map.ts';

export interface GroupCExample {
  /** `record_type`, plus the variant when one record type has several examples. */
  readonly label: string;
  readonly record: GroupCRecord;
  /** Top-level members that may be omitted on their own (absent, never null). */
  readonly optional: readonly string[];
}

/**
 * Builds an example; `optional` defaults to none.
 *
 * @example
 * groupCExample('cli_result', completedCliResult(), ['result_record']);
 */
export function groupCExample(label: string, record: GroupCRecord, optional: readonly string[] = []): GroupCExample {
  return { label, record, optional };
}
