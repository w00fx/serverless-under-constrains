// `provider_execution_configuration` (BR-RUA-018, AC-RUA-042; Owner amendment A-09, human
// decision): the immutable execution-level control item, pk `<execution_id>#execution`, sk
// `config`. The runner writes it once at execution start; the provider reads it to journal a call
// it cannot attribute to a trial partition in `<execution_id>#provider`, under this digest.

import type { Sha256Hex, UtcMillis, Uuid4 } from '../../primitives.ts';

export type ProviderExecutionConfigurationIdentity =
  | {
      readonly execution_kind: 'RUN';
      readonly run_id: Uuid4;
      readonly variant_validation_id?: never;
      readonly transport_probe_id?: never;
    }
  | {
      readonly execution_kind: 'VARIANT_VALIDATION';
      readonly variant_validation_id: Uuid4;
      readonly run_id?: never;
      readonly transport_probe_id?: never;
    }
  | {
      readonly execution_kind: 'TRANSPORT_PROBE';
      readonly transport_probe_id: Uuid4;
      readonly run_id?: never;
      readonly variant_validation_id?: never;
    };

export type ProviderExecutionConfiguration = ProviderExecutionConfigurationIdentity & {
  readonly schema_version: 1;
  readonly record_type: 'provider_execution_configuration';
  readonly execution_manifest_sha256: Sha256Hex;
  readonly written_at: UtcMillis;
};
