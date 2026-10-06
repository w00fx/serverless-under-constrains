// The shape every group-B example shares, so generic AC-RUA-046 checks can run over all of
// them: a typed record, the members (top-level and nested) whose single removal keeps it valid,
// and the members the catalogue copies verbatim from untrusted input (any string is valid there).

import type { GroupBRecord } from '../../../../../src/record-contract/records/group-b/record-map.ts';

export interface RecordExample {
  /** `record_type`, plus the variant when one record type has several examples. */
  readonly label: string;
  readonly record: GroupBRecord;
  /** Top-level members that may be omitted on their own (absent, never null). */
  readonly optional: readonly string[];
  /** Top-level members typed as an unconstrained string (verbatim copies of rejected input). */
  readonly verbatim: readonly string[];
  /**
   * Nested members that may be omitted on their own, as JSON Pointer patterns where `*` stands
   * for every array index (`/executions/*\/ended_at`). Every other nested member is required.
   */
  readonly nested_optional: readonly string[];
}

interface ExampleMembers {
  readonly optional?: readonly string[];
  readonly verbatim?: readonly string[];
  readonly nested_optional?: readonly string[];
}

/**
 * Builds an example; `optional`, `verbatim` and `nested_optional` default to none.
 *
 * @example
 * example('dispatch_started', dispatchStarted(), { optional: ['causation_event_ids'] });
 */
export function example(label: string, record: GroupBRecord, members: ExampleMembers = {}): RecordExample {
  return {
    label,
    record,
    optional: members.optional ?? [],
    verbatim: members.verbatim ?? [],
    nested_optional: members.nested_optional ?? [],
  };
}
