// The conventional caller's environment (design §9.4): a run or variant-validation identity, the
// two tables it may touch, the provider's published version and its variant id.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONVENTIONAL_ENVIRONMENT_VARIABLES,
  parseConventionalEnvironment,
} from '../../../src/conventional-variant/conventional-environment.ts';

const EXECUTION_ID = '6b4c9d2e-1a3f-4b5c-9d8e-7f6a5b4c3d2e';

function environment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    SUC_EXECUTION_KIND: 'RUN',
    SUC_EXECUTION_ID: EXECUTION_ID,
    SUC_TABLE_CALLER_JOURNAL: 'suc1-6b4c9d2e-caller-journal',
    SUC_TABLE_TRIAL_REGISTRY: 'suc1-6b4c9d2e-trial-registry',
    SUC_PROVIDER_FUNCTION_NAME: 'SucRua-run-provider',
    SUC_PROVIDER_QUALIFIER: '3',
    SUC_VARIANT_ID: 'conventional',
    ...overrides,
  };
}

describe('parseConventionalEnvironment', () => {
  it('names the variables of design §9.4', () => {
    assert.deepEqual(Object.values(CONVENTIONAL_ENVIRONMENT_VARIABLES), [
      'SUC_EXECUTION_KIND',
      'SUC_EXECUTION_ID',
      'SUC_TABLE_CALLER_JOURNAL',
      'SUC_TABLE_TRIAL_REGISTRY',
      'SUC_PROVIDER_FUNCTION_NAME',
      'SUC_PROVIDER_QUALIFIER',
      'SUC_VARIANT_ID',
    ]);
  });

  it('reads a run deployment', () => {
    assert.deepEqual(parseConventionalEnvironment(environment()), {
      ok: true,
      value: {
        deployment: { execution_kind: 'RUN', run_id: EXECUTION_ID },
        caller_journal_table: 'suc1-6b4c9d2e-caller-journal',
        trial_registry_table: 'suc1-6b4c9d2e-trial-registry',
        provider_function_name: 'SucRua-run-provider',
        provider_qualifier: '3',
      },
    });
  });

  it('reads a variant-validation deployment', () => {
    const parsed = parseConventionalEnvironment(environment({ SUC_EXECUTION_KIND: 'VARIANT_VALIDATION' }));
    assert.deepEqual(parsed.ok ? parsed.value.deployment : undefined, {
      execution_kind: 'VARIANT_VALIDATION',
      variant_validation_id: EXECUTION_ID,
    });
  });

  it('names each malformed variable with its value and the expected shape', () => {
    const cases: readonly (readonly [Readonly<Record<string, string | undefined>>, string])[] = [
      [
        { SUC_EXECUTION_KIND: 'TRANSPORT_PROBE' },
        'SUC_EXECUTION_KIND string "TRANSPORT_PROBE"; expected RUN or VARIANT_VALIDATION',
      ],
      [
        { SUC_EXECUTION_ID: EXECUTION_ID.toUpperCase() },
        `SUC_EXECUTION_ID string "${EXECUTION_ID.toUpperCase()}"; expected a lowercase RFC 4122 version-4 UUID`,
      ],
      [{ SUC_TABLE_CALLER_JOURNAL: ' ' }, 'SUC_TABLE_CALLER_JOURNAL string " "; expected a non-empty table name'],
      [{ SUC_TABLE_TRIAL_REGISTRY: undefined }, 'SUC_TABLE_TRIAL_REGISTRY absent; expected a non-empty table name'],
      [{ SUC_PROVIDER_FUNCTION_NAME: '' }, 'SUC_PROVIDER_FUNCTION_NAME string ""; expected a non-empty function name'],
      [
        { SUC_PROVIDER_QUALIFIER: '$LATEST' },
        'SUC_PROVIDER_QUALIFIER string "$LATEST"; expected a published version number',
      ],
      [{ SUC_PROVIDER_QUALIFIER: '03' }, 'SUC_PROVIDER_QUALIFIER string "03"; expected a published version number'],
      [{ SUC_PROVIDER_QUALIFIER: undefined }, 'SUC_PROVIDER_QUALIFIER absent; expected a published version number'],
      [{ SUC_VARIANT_ID: 'durable' }, 'SUC_VARIANT_ID string "durable"; expected conventional'],
    ];
    for (const [overrides, problem] of cases) {
      assert.deepEqual(parseConventionalEnvironment(environment(overrides)), {
        ok: false,
        error: `conventional caller environment invalid: ${problem}`,
      });
    }
  });

  it('lists every problem at once', () => {
    const parsed = parseConventionalEnvironment({});
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.split('; expected').length - 1, 7);
  });
});
