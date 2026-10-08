// Catalogue group C row 77 (design §6.2): one line of `late-evidence/late-evidence-stream.jsonl`,
// a record observed after the final freeze (BR-RUA-043). The late record is carried as parsed
// JSON and validated against its own schema by ingestion; frozen evidence is never modified.

import type { JsonObject, UtcMillis } from '../../primitives.ts';
import type { ExecutionCorrelation, ExecutionScoped, TrialScoped } from './shared-shapes.ts';
import type { LateEvidenceSource } from './vocabulary.ts';

interface LateEvidenceRecordFields {
  readonly schema_version: 1;
  readonly record_type: 'late_evidence_record';
  /** Dense from 1 within the stream. */
  readonly sequence: number;
  readonly captured_at: UtcMillis;
  readonly late_source: LateEvidenceSource;
  /** Whether the record correlates with a frozen trial or the probe (`none` means zero of these). */
  readonly correlated: boolean;
  /** The `record_type` of the carried record, lowercase snake. */
  readonly late_record_type: string;
  readonly late_record: JsonObject;
}

/** Schema: `schemas/group-c/late_evidence_record.schema.json`. The trial pair names the correlated trial. */
export type LateEvidenceRecord = ExecutionCorrelation & LateEvidenceRecordFields & (TrialScoped | ExecutionScoped);
