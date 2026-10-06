// Synthetic equality inputs: the four canonical trial slots (RUN_TRIAL_ORDER) with one sheet per
// projection, so a test states only the fields it varies. Each sheet cites one evidence reference
// of its own trial, so the projection's evidence is the union of its covered trials.

import type { EvidenceRef } from '../../../../src/record-contract/evidence-refs.ts';
import type { JsonObject, Sha256Hex, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { RUN_TRIAL_ORDER } from '../../../../src/record-contract/records/group-a/execution_manifest.ts';
import type { DeclaredVariantDifference } from '../../../../src/record-contract/records/group-a/execution_manifest.ts';
import type { EqualityProjectionId } from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import type { ComparisonTrialInputs, ProjectionInput } from '../../../../src/study-comparison/equality-sheets.ts';

/** The eight projection ids in their fixed order. */
export const PROJECTION_IDS = [
  'financial_inputs',
  'control_parameters',
  'treatment_parameters',
  'message_source_protocol',
  'provider_configuration',
  'controller_configuration',
  'caller_timing',
  'observation_window',
] as const satisfies readonly EqualityProjectionId[];

/** The four synthetic trial ids, in slot order. */
export const SLOT_TRIAL_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
] as const satisfies readonly string[];

/** One declared difference: a 60 s conventional and 360 s durable visibility timeout. */
export const VISIBILITY_DIFFERENCE: DeclaredVariantDifference = {
  parameter: 'source_visibility_timeout_ms',
  conventional: 60_000,
  durable: 360_000,
  basis: 'BR-RUA-020',
};

/** Per slot index, the sheet fields that slot shows for the given projection. */
export type SheetOverrides = Partial<
  Record<
    EqualityProjectionId,
    (slot: number) => ProjectionInput | { readonly common?: JsonObject; readonly within_variant?: JsonObject }
  >
>;

/**
 * The evidence reference a synthetic slot cites.
 *
 * @example
 * slotRef(0).artifact_path; // 'trials/00000000-0000-4000-8000-000000000001/x.json'
 */
export function slotRef(slot: number): EvidenceRef {
  return {
    artifact_path: `trials/${SLOT_TRIAL_IDS[slot] ?? 'none'}/x.json`,
    artifact_sha256: String(slot).repeat(64) as Sha256Hex,
  };
}

/**
 * The four synthetic trials; every projection holds `{ shared: 1 }` unless overridden.
 *
 * @example
 * slotInputs({ observation_window: (slot) => ({ common: { deadline: slot === 3 ? 2 : 1 } }) });
 */
export function slotInputs(overrides: SheetOverrides = {}): readonly ComparisonTrialInputs[] {
  return RUN_TRIAL_ORDER.map((slot, index) => ({
    trial_id: (SLOT_TRIAL_IDS[index] ?? SLOT_TRIAL_IDS[0]) as Uuid4,
    variant_id: slot.variant_id,
    scenario: slot.scenario,
    projections: Object.fromEntries(
      PROJECTION_IDS.map((id) => [id, projectionInput(overrides[id]?.(index), index)]),
    ) as Record<EqualityProjectionId, ProjectionInput>,
  }));
}

function projectionInput(
  override: ProjectionInput | { readonly common?: JsonObject; readonly within_variant?: JsonObject } | undefined,
  slot: number,
): ProjectionInput {
  if (override !== undefined && ('sheet' in override || 'missing' in override)) {
    return override;
  }
  return {
    sheet: {
      common: override?.common ?? { shared: 1 },
      within_variant: override?.within_variant ?? {},
      evidence_refs: [slotRef(slot)],
    },
  };
}
