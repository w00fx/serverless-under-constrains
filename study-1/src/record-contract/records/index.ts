// Common supertype of every catalogued record (BR-RUA-033: each JSON record and JSONL line
// carries `schema_version: 1` and a lowercase `record_type`).
//
// The per-type interfaces live in `group-a/`, `group-b/` and `group-c/` (WP-01..WP-03), one
// file per record type, and consumers import them by subpath (design §13 contention rule 2).
// This index deliberately does not re-export those directories: each catalogue package
// builds in its own worktree without the others, and a barrel naming absent modules would
// fail every typecheck there. Every record interface is structurally assignable to this one.

import type { RecordType } from '../record-types.ts';

export interface StudyRecord {
  readonly schema_version: 1;
  readonly record_type: RecordType;
}
