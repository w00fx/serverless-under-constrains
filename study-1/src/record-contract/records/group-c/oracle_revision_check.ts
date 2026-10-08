// Catalogue group C row 87 (design §6.2, §10.1 A9, D-18): the golden-suite attestation that the
// oracle is final at a commit (BR-RUA-055, AC-RUA-055). Admission freezes it in
// `admission/oracle-revision-check.json`; `rua oracle revision-check` prints the same record.

import type { Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../../primitives.ts';
import type { RevisionCheckResult } from './vocabulary.ts';

/** The run-suite counts of the golden suite. */
export interface GoldenTestCounts {
  readonly tests: number;
  readonly pass: number;
  readonly fail: number;
  readonly skipped: number;
  readonly todo: number;
}

/** The passing golden cases that reach one verdict-changing `(rule, outcome)` pair. */
export interface RuleCoverage {
  /** A rule id such as `BR-RUA-001` or a gate id such as `ledger_access`. */
  readonly rule_id: string;
  /** The outcome reached, lowercase (`pass`, `verified`, ...). */
  readonly outcome: string;
  readonly case_ids: readonly string[];
}

interface OracleRevisionCheckFields {
  readonly schema_version: 1;
  readonly record_type: 'oracle_revision_check';
  /** Present when the check ran inside an admission attempt. */
  readonly admission_attempt_id?: Uuid4;
  readonly commit_sha: string;
  readonly tree_sha: string;
  readonly command: string;
  readonly exit_code: number;
  readonly report_sha256: Sha256Hex;
  readonly test_counts: GoldenTestCounts;
  readonly golden_minimum: number;
  readonly rule_coverage: readonly RuleCoverage[];
  /** Verdict-changing pairs with no passing case. */
  readonly uncovered: readonly string[];
  readonly node_version: string;
  readonly checked_at: UtcMillis;
}

/** `passed` needs exit 0, no failed, skipped or todo test, and no uncovered pair (D-18). */
export type RevisionCheckOutcome =
  | { readonly result: Extract<RevisionCheckResult, 'passed'>; readonly reasons: readonly [] }
  | {
      readonly result: Extract<RevisionCheckResult, 'failed'>;
      readonly reasons: readonly [StructuredReason, ...StructuredReason[]];
    };

/** Schema: `schemas/group-c/oracle_revision_check.schema.json`. */
export type OracleRevisionCheck = OracleRevisionCheckFields & RevisionCheckOutcome;
