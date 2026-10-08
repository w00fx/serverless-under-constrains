// Catalogue group C row 88 (design §6.2, §11): the single canonical-JSON line the operator CLI
// prints on stdout. It is never evidence (OQ-RUA-003, D-14).

import type { JsonObject, StructuredReason, Uuid4, UtcMillis } from '../../primitives.ts';

/** Each outcome has exactly one exit code (design §11 table; `CLI_OUTCOMES` / `CLI_EXIT_CODES`). */
export type CliOutcomeCode =
  | { readonly outcome: 'completed'; readonly exit_code: 0 }
  | { readonly outcome: 'usage_error'; readonly exit_code: 2 }
  | { readonly outcome: 'admission_rejected'; readonly exit_code: 3 }
  | { readonly outcome: 'execution_incomplete'; readonly exit_code: 4 }
  | { readonly outcome: 'verification_failed'; readonly exit_code: 5 }
  | { readonly outcome: 'operational_closure_not_clean'; readonly exit_code: 6 }
  | { readonly outcome: 'lease_problem'; readonly exit_code: 7 }
  | { readonly outcome: 'internal_failure'; readonly exit_code: 10 };

interface CliResultFields {
  readonly schema_version: 1;
  readonly record_type: 'cli_result';
  /** The command words, for example `probe verify`. */
  readonly command: string;
  /** At most one execution identity, when the command concerns one execution. */
  readonly run_id?: Uuid4;
  readonly transport_probe_id?: Uuid4;
  readonly variant_validation_id?: Uuid4;
  /** Paths written, relative to the evidence root. */
  readonly written_paths: readonly string[];
  /** The record the command produced, for example the `oracle_result` of `oracle evaluate`. */
  readonly result_record?: JsonObject;
  readonly reasons: readonly StructuredReason[];
  readonly completed_at: UtcMillis;
}

/** Schema: `schemas/group-c/cli_result.schema.json`. */
export type CliResult = CliResultFields & CliOutcomeCode;
