// AC-RUA-046 (group A) record contract of the execution manifest (BR-RUA-040): the declared
// order of BR-RUA-019 and BR-RUA-038, seed 1, the declared inputs of OR-RUA-001..005, the
// warm-up policy (addendum §2), CA-1, the qualification rule per execution kind (BR-RUA-028).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import {
  RUN_TRIAL_ORDER,
  VALIDATION_SCENARIO_ORDER,
} from '../../../../src/record-contract/records/group-a/execution_manifest.ts';
import type { DeclaredTrial } from '../../../../src/record-contract/records/group-a/execution_manifest.ts';
import {
  probeExecutionManifest,
  runExecutionManifest,
  validationExecutionManifest,
} from './support/manifest-examples.ts';
import { IDS } from './support/sample-values.ts';
import {
  asJson,
  assertAccepted,
  assertRejected,
  catalogueValidator,
  withField,
  withPath,
  withoutField,
} from './support/validation-assertions.ts';

function permutations<T>(items: readonly T[]): readonly (readonly T[])[] {
  if (items.length <= 1) {
    return [items];
  }
  return items.flatMap((item, index) =>
    permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]),
  );
}

const projection = (trials: readonly DeclaredTrial[]): readonly object[] =>
  trials.map(({ sequence, variant_id, scenario }) => ({ sequence, variant_id, scenario }));

describe('execution_manifest (BR-RUA-040)', () => {
  it('accepts a run, a variant validation and a transport probe', () => {
    assertAccepted(runExecutionManifest(), 'run');
    assertAccepted(validationExecutionManifest(), 'variant validation');
    assertAccepted(probeExecutionManifest(), 'transport probe');
  });

  it('declares the four run trials only in the BR-RUA-019 order', () => {
    assert.deepEqual(projection(runExecutionManifest().trials), RUN_TRIAL_ORDER);
    const trials = runExecutionManifest().trials;
    const orders = permutations([0, 1, 2, 3]);
    assert.equal(orders.length, 24);
    for (const order of orders) {
      const renumbered = order.map((from, position) => ({ ...trials[from], sequence: position + 1 }));
      const valid = catalogueValidator.validate(withField(runExecutionManifest(), 'trials', renumbered)).valid;
      assert.equal(valid, order.join() === '0,1,2,3', `trial order ${order.join()}`);
    }
    assertRejected(withField(runExecutionManifest(), 'trials', trials.slice(0, 3)), '/trials minItems', 'three trials');
    assertRejected(
      withField(runExecutionManifest(), 'trials', [...trials, ...trials.slice(0, 1)]),
      '/trials maxItems',
      'five trials',
    );
  });

  it('declares one variant control then treatment for a variant validation (BR-RUA-038)', () => {
    const trials = validationExecutionManifest().trials;
    assert.deepEqual(
      trials.map((trial) => trial.scenario),
      VALIDATION_SCENARIO_ORDER,
    );
    assertRejected(
      withField(validationExecutionManifest(), 'trials', [
        { ...trials[1], sequence: 1 },
        { ...trials[0], sequence: 2 },
      ]),
      '/trials/0/scenario const',
      'treatment first',
    );
    assertRejected(
      withPath(validationExecutionManifest(), ['trials', 1, 'variant_id'], 'conventional'),
      '/trials/1/variant_id const',
      'mixed variants',
    );
    const conventional = withField(validationExecutionManifest(), 'variant_id', 'conventional');
    assertRejected(conventional, '/trials/0/variant_id const', 'trials of another variant');
    assertRejected(withoutField(validationExecutionManifest(), 'variant_id'), ' required', 'no variant');
    assertRejected(
      withField(validationExecutionManifest(), 'trials', trials.slice(0, 1)),
      '/trials minItems',
      'control only',
    );
  });

  it('gives a transport probe no trials, no variant and no consumed qualification', () => {
    assertRejected(
      withField(probeExecutionManifest(), 'trials', runExecutionManifest().trials),
      '/trials maxItems',
      'trials',
    );
    assertRejected(withField(probeExecutionManifest(), 'variant_id', 'durable'), '/variant_id false schema', 'variant');
    assertRejected(
      withField(runExecutionManifest(), 'variant_id', 'durable'),
      '/variant_id false schema',
      'run variant',
    );
  });

  it('matches the execution identity to the execution kind', () => {
    const runAsValidation = {
      ...withoutField(runExecutionManifest(), 'run_id'),
      variant_validation_id: IDS.variantValidation,
    };
    assertRejected(runAsValidation, ' required', 'RUN with a variant-validation identity');
    assertRejected(
      withField(runExecutionManifest(), 'transport_probe_id', IDS.transportProbe),
      ' oneOf',
      'two identities',
    );
    assertRejected(withoutField(probeExecutionManifest(), 'transport_probe_id'), ' oneOf', 'no identity');
  });

  it('requires the selected qualification of a run or validation; the amendment head is optional', () => {
    assertRejected(withoutField(runExecutionManifest(), 'qualification'), ' required', 'missing');
    assertRejected(
      withPath(runExecutionManifest(), ['qualification', 'transport_probe_id'], 'probe-1'),
      '/qualification/transport_probe_id pattern',
      'probe id',
    );
    assertRejected(
      withField(runExecutionManifest(), 'qualification', { transport_probe_id: IDS.transportProbe }),
      '/qualification required',
      'no index',
    );
  });

  it('records seed 1 and the single provider warm-up per trial', () => {
    assertRejected(withField(runExecutionManifest(), 'seed', 2), '/seed const', 'seed');
    assertRejected(withoutField(runExecutionManifest(), 'seed'), ' required', 'no seed');
    assertRejected(
      withPath(runExecutionManifest(), ['provider_warmup', 'invocations_per_trial'], 2),
      '/provider_warmup/invocations_per_trial const',
      'two warm-ups',
    );
    assertRejected(withoutField(runExecutionManifest(), 'provider_warmup'), ' required', 'no warm-up policy');
  });

  it('declares the financial, timing and safety inputs', () => {
    assertRejected(
      withPath(runExecutionManifest(), ['financial_inputs', 'currency'], 'USD'),
      '/financial_inputs/currency const',
      'currency',
    );
    assertRejected(
      withPath(runExecutionManifest(), ['financial_inputs', 'decision'], 'DENIED'),
      '/financial_inputs/decision const',
      'decision',
    );
    assertRejected(
      withPath(runExecutionManifest(), ['timing', 'retry_jitter'], 'FULL'),
      '/timing/retry_jitter const',
      'jitter',
    );
    assertRejected(
      withPath(runExecutionManifest(), ['timing', 'max_receive_count'], 0),
      '/timing/max_receive_count minimum',
      'receives',
    );
    const timing = runExecutionManifest().timing as unknown as JsonObject;
    for (const field of Object.keys(timing)) {
      const without = Object.fromEntries(Object.entries(timing).filter(([name]) => name !== field));
      assertRejected(withField(runExecutionManifest(), 'timing', without), '/timing required', `missing ${field}`);
    }
    assertRejected(
      withPath(runExecutionManifest(), ['safety', 'region'], 'eu-west-1'),
      '/safety/region const',
      'region',
    );
    assertRejected(
      withPath(runExecutionManifest(), ['safety', 'concurrent_owners'], 2),
      '/safety/concurrent_owners const',
      'owners',
    );
    assertRejected(withPath(runExecutionManifest(), ['safety', 'total_ms'], 0), '/safety/total_ms minimum', 'total');
  });

  it('freezes the admitted environment, clean source and schema digests', () => {
    assertRejected(
      withPath(runExecutionManifest(), ['environment', 'account_id'], '12345'),
      '/environment/account_id pattern',
      'account',
    );
    assertRejected(
      withPath(runExecutionManifest(), ['environment', 'region'], 'us-west-2'),
      '/environment/region const',
      'region',
    );
    const environmentWithSecret = { ...asJson(runExecutionManifest().environment), aws_secret_access_key: 'x' };
    assertRejected(
      withField(runExecutionManifest(), 'environment', environmentWithSecret),
      '/environment additionalProperties',
      'secret',
    );
    assertRejected(
      withPath(runExecutionManifest(), ['source', 'clean_confirmed'], false),
      '/source/clean_confirmed const',
      'dirty',
    );
    assertAccepted(
      withPath(runExecutionManifest(), ['source'], { ...asJson(runExecutionManifest().source), branch: 'main' }),
      'branch',
    );
    assertRejected(withField(runExecutionManifest(), 'schema_files', []), '/schema_files minItems', 'no schemas');
    assertRejected(
      withPath(runExecutionManifest(), ['schema_files', 0, 'relative_path'], '/abs.json'),
      '/schema_files/0/relative_path format',
      'path',
    );
    assertRejected(
      withPath(runExecutionManifest(), ['deployment_assembly', 'template_sha256'], 'x'),
      '/deployment_assembly/template_sha256 pattern',
      'template',
    );
  });

  it('declares CA-1 verbatim as a non-guaranteed clock assumption', () => {
    const [ca1] = runExecutionManifest().clock_assumptions;
    assertRejected(withField(runExecutionManifest(), 'clock_assumptions', []), '/clock_assumptions minItems', 'none');
    assertRejected(
      withField(runExecutionManifest(), 'clock_assumptions', [ca1, ca1]),
      '/clock_assumptions maxItems',
      'two',
    );
    assertRejected(
      withPath(runExecutionManifest(), ['clock_assumptions', 0, 'status'], 'guaranteed'),
      '/clock_assumptions/0/status const',
      'status',
    );
    assertRejected(
      withPath(runExecutionManifest(), ['clock_assumptions', 0, 'assumption_id'], 'CA-2'),
      '/clock_assumptions/0/assumption_id const',
      'id',
    );
  });

  it('records the declared variant differences of BR-RUA-007', () => {
    const conventional = ['declared_variant_differences', 0, 'conventional'] as const;
    for (const value of ['STANDARD', true, 9007199254740991]) {
      assertAccepted(withPath(runExecutionManifest(), conventional, value), `scalar ${JSON.stringify(value)}`);
    }
    for (const value of [{ VisibilityTimeout: 60 }, [60], '', 60.5, 9007199254740992]) {
      assertRejected(
        withPath(runExecutionManifest(), conventional, value),
        '/declared_variant_differences/0/conventional anyOf',
        `declared value ${JSON.stringify(value)}`,
      );
    }
    assertRejected(
      withPath(runExecutionManifest(), ['declared_variant_differences', 0, 'basis'], ''),
      '/declared_variant_differences/0/basis minLength',
      'basis',
    );
    assertRejected(
      withPath(runExecutionManifest(), ['declared_variant_differences', 0, 'parameter'], 'VisibilityTimeout'),
      '/declared_variant_differences/0/parameter pattern',
      'name',
    );
    assertRejected(
      withPath(runExecutionManifest(), ['estimates', 'resource_counts'], {}),
      '/estimates/resource_counts minProperties',
      'counts',
    );
  });
});
