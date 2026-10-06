// What the late-evidence assessment receives (BR-RUA-043, design §5.3 `assessLateEvidence`, §8.13,
// D-16): every frozen trial of one run or variant validation, each with the exact evidence the
// oracle evaluated at freeze and the exact bytes of its frozen oracle result, the late-evidence
// stream observed after the final freeze, and how late monitoring ended. Type-only: no runtime
// code (A-10). The probe is not a trial: its frozen result is a transport-probe result, which this
// trial-oracle module cannot re-derive (design §5.4 layers; evidence/WP-15/decisions.md).

import type { IngestionInput, RawArtifact } from '../../evidence-ingestion/ingestion-model.ts';
import type { Sha256Hex, UtcMillis } from '../../record-contract/primitives.ts';
import type { TrialExecutionIdentity } from '../../record-contract/records/group-c/shared-shapes.ts';

/** One frozen trial: the evidence its oracle result was derived from, and that result's bytes. */
export interface FrozenTrialEvidence {
  /** The trial's frozen evidence, exactly as the oracle ingested it at freeze. */
  readonly frozen: IngestionInput;
  /** `trials/<trial_id>/derived/oracle-result.json` and its exact stored bytes. */
  readonly result: RawArtifact;
}

/**
 * How late monitoring ended. `complete` is the normal monitoring of at least 120 s after the final
 * trial freeze; emergency cleanup may shorten or skip it, and a monitor may fail (BR-RUA-043).
 * A skipped monitoring has no window.
 */
export type LateMonitoring =
  | { readonly outcome: 'complete'; readonly started_at: UtcMillis; readonly ended_at: UtcMillis }
  | { readonly outcome: 'shortened' | 'failed'; readonly started_at?: UtcMillis; readonly ended_at?: UtcMillis }
  | { readonly outcome: 'skipped' };

/** Everything one execution's late-evidence assessment reads. */
export interface LateEvidenceInput {
  readonly execution: TrialExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly monitoring: LateMonitoring;
  /** `late-evidence/late-evidence-stream.jsonl`; absent when no stream was written. */
  readonly stream?: RawArtifact;
  /** Every trial that has a frozen oracle result, in declared order. */
  readonly trials: readonly FrozenTrialEvidence[];
  readonly assessed_at: UtcMillis;
}
