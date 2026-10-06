// Valid examples of the schema branches the canonical examples do not take: the variant-validation
// side of every run-or-validation oneOf (BR-RUA-038), a conventional variant validation, the
// variant-specific validation stack (BR-RUA-050) and a detached source checkout (BR-RUA-042).
// Each is derived from its canonical example, so the two cannot drift apart except in the
// branch-selecting members.

import type { JsonObject } from '../../../../../src/record-contract/primitives.ts';
import type { OwnershipTagEntry } from '../../../../../src/record-contract/records/group-a/resource_manifest.ts';
import { sourceProvenance } from './admission-examples.ts';
import { trialMessage, trialProviderRefundCall } from './input-examples.ts';
import {
  succeededResourceManifest,
  trialManifest,
  trialRegistration,
  validationExecutionManifest,
} from './manifest-examples.ts';
import { IDS } from './sample-values.ts';
import { asJson, withField, withoutField } from './validation-assertions.ts';

/**
 * Moves a run-scoped record into the variant validation: `run_id` becomes `variant_validation_id`.
 *
 * @example
 * inVariantValidation(trialMessage()); // { ..., variant_validation_id: IDS.variantValidation }
 */
export function inVariantValidation(record: object): JsonObject {
  return { ...withoutField(record, 'run_id'), variant_validation_id: IDS.variantValidation };
}

/**
 * The validation's treatment trial manifest: BR-RUA-038 position 2, `COMMIT_THEN_TIMEOUT`.
 *
 * @example
 * validationTrialManifest()['sequence']; // 2
 */
export function validationTrialManifest(): JsonObject {
  return { ...inVariantValidation(trialManifest()), sequence: 2 };
}

/**
 * A conventional variant validation: the declared variant and both trials are conventional.
 *
 * @example
 * conventionalValidationExecutionManifest()['variant_id']; // 'conventional'
 */
export function conventionalValidationExecutionManifest(): JsonObject {
  const manifest = validationExecutionManifest();
  return asJson({
    ...manifest,
    variant_id: 'conventional',
    trials: manifest.trials.map((trial) => ({ ...trial, variant_id: 'conventional' })),
  });
}

/**
 * The Durable variant validation's stack: variant-specific, so its ownership tags add
 * `suc:variant_id` (BR-RUA-050), and its run tag carries the validation identity.
 *
 * @example
 * validationResourceManifest()['stack_name']; // 'SucRua-validation-00000000'
 */
export function validationResourceManifest(): JsonObject {
  const run = succeededResourceManifest();
  const tags: readonly OwnershipTagEntry[] = [
    ...run.ownership_tags.map((tag) => (tag.key === 'suc:run_id' ? { ...tag, value: IDS.variantValidation } : tag)),
    { key: 'suc:variant_id', value: 'durable' },
  ];
  const stackId = (run.stack_id ?? '').replaceAll('SucRua-run-', 'SucRua-validation-');
  const renamed = withField(inVariantValidation(run), 'stack_name', 'SucRua-validation-00000000');
  return withField(withField(renamed, 'stack_id', stackId), 'ownership_tags', tags);
}

/**
 * A clean checkout on a detached HEAD: no branch to name (BR-RUA-042).
 *
 * @example
 * detachedSourceProvenance()['detached_head']; // true
 */
export function detachedSourceProvenance(): JsonObject {
  return { ...withoutField(sourceProvenance(), 'branch'), detached_head: true };
}

/**
 * Every branch example with its label, for the catalogue-wide properties.
 *
 * @example
 * branchExamples().map((example) => example.name);
 */
export function branchExamples(): readonly { readonly name: string; readonly record: JsonObject }[] {
  return [
    { name: 'trial_message (variant validation)', record: inVariantValidation(trialMessage()) },
    { name: 'provider_refund_call (variant validation)', record: inVariantValidation(trialProviderRefundCall()) },
    { name: 'trial_registration (variant validation)', record: inVariantValidation(trialRegistration()) },
    { name: 'trial_manifest (variant validation)', record: validationTrialManifest() },
    { name: 'execution_manifest (conventional variant validation)', record: conventionalValidationExecutionManifest() },
    { name: 'resource_manifest (variant validation stack)', record: validationResourceManifest() },
    { name: 'source_provenance (detached HEAD)', record: detachedSourceProvenance() },
  ];
}
