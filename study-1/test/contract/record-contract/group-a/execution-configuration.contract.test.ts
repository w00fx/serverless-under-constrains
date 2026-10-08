// AC-RUA-046 (group A) record contract of `provider_execution_configuration`, the execution-level
// control `config` item of Owner amendment A-09 (human decision): it names one execution, of the
// declared kind, and its frozen manifest digest, so the provider can journal a call it cannot
// attribute to a trial (AC-RUA-042).

import { describe, it } from 'node:test';

import {
  probeProviderExecutionConfiguration,
  runProviderExecutionConfiguration,
  validationProviderExecutionConfiguration,
} from './support/manifest-examples.ts';
import { DIGESTS, IDS } from './support/sample-values.ts';
import { assertAccepted, assertRejected, withField, withoutField } from './support/validation-assertions.ts';

describe('provider_execution_configuration (BR-RUA-018, AC-RUA-042, A-09)', () => {
  it('accepts the configuration of a run, a variant validation and a transport probe', () => {
    assertAccepted(runProviderExecutionConfiguration(), 'run');
    assertAccepted(validationProviderExecutionConfiguration(), 'variant validation');
    assertAccepted(probeProviderExecutionConfiguration(), 'transport probe');
  });

  it('names exactly one execution, the one of the declared kind', () => {
    const run = runProviderExecutionConfiguration();
    assertRejected(withoutField(run, 'execution_kind'), ' required', 'no kind');
    assertRejected(withField(run, 'execution_kind', 'TRIAL'), '/execution_kind enum', 'unknown kind');
    assertRejected(withoutField(run, 'run_id'), ' oneOf', 'no execution identity');
    assertRejected(
      withField(run, 'variant_validation_id', IDS.variantValidation),
      ' oneOf',
      'two execution identities',
    );
    const kindMismatches = [
      [withField(run, 'execution_kind', 'VARIANT_VALIDATION'), 'run id declared as a validation'],
      [withField(run, 'execution_kind', 'TRANSPORT_PROBE'), 'run id declared as a probe'],
      [withField(validationProviderExecutionConfiguration(), 'execution_kind', 'RUN'), 'validation declared as a run'],
    ] as const;
    for (const [record, label] of kindMismatches) {
      assertRejected(record, ' required', label);
    }
    assertRejected(
      withField(run, 'run_id', 'aaaaaaaa-0000-1000-8000-000000000001'),
      '/run_id pattern',
      'version-1 run id',
    );
  });

  it('declares the frozen manifest digest and nothing about a trial', () => {
    const run = runProviderExecutionConfiguration();
    assertRejected(withoutField(run, 'execution_manifest_sha256'), ' required', 'no digest');
    assertRejected(
      withField(run, 'execution_manifest_sha256', DIGESTS.executionManifest.toUpperCase()),
      '/execution_manifest_sha256 pattern',
      'uppercase digest',
    );
    assertRejected(withField(run, 'trial_id', IDS.trial1), ' additionalProperties', 'trial');
    assertRejected(withoutField(run, 'written_at'), ' required', 'no write time');
  });
});
