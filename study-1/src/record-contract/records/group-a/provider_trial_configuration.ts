// `provider_trial_configuration` (BR-RUA-025, BR-RUA-018): the immutable control-table `config`
// item. It declares the scenario, the single registered caller and the execution the provider
// accepts; the probe configuration always declares the treatment it qualifies.

import type { Scenario, Sha256Hex, UtcMillis, Uuid4 } from '../../primitives.ts';
import type { TrialReference, TrialScopedIdentityFields } from './trial_manifest.ts';

export type ProviderConfigurationScope =
  | (TrialScopedIdentityFields &
      TrialReference & {
        readonly registered_caller_id: 'conventional' | 'durable';
        readonly scenario: Scenario;
        readonly transport_probe_id?: never;
      })
  | {
      readonly transport_probe_id: Uuid4;
      readonly registered_caller_id: 'probe';
      readonly scenario: 'COMMIT_THEN_TIMEOUT';
      readonly run_id?: never;
      readonly variant_validation_id?: never;
      readonly trial_id?: never;
      readonly trial_manifest_sha256?: never;
    };

export type ProviderTrialConfiguration = ProviderConfigurationScope & {
  readonly schema_version: 1;
  readonly record_type: 'provider_trial_configuration';
  readonly execution_manifest_sha256: Sha256Hex;
  readonly payment_id: string;
  /** OR-RUA-002: 15 s after commit. */
  readonly safety_release_ms: number;
  /** OR-RUA-002: 250 ms. */
  readonly treatment_poll_interval_ms: number;
  readonly written_at: UtcMillis;
};
