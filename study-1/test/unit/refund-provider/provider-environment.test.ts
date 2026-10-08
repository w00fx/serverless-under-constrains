// The provider function environment (design §9.4): the execution identity and the three table
// names its IAM role allows (§9.6); every problem is named at once.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseProviderEnvironment } from '../../../src/refund-provider/provider-environment.ts';
import { PROBE_ID, RUN_ID, VALIDATION_ID } from '../../support/refund-provider/provider-fixtures.ts';

const TABLES = {
  SUC_TABLE_LEDGER: 'suc1-aaaaaaaa-ledger',
  SUC_TABLE_EXPERIMENT_JOURNAL: 'suc1-aaaaaaaa-experiment-journal',
  SUC_TABLE_CONTROL: 'suc1-aaaaaaaa-control',
};

describe('parseProviderEnvironment', () => {
  it('reads each execution kind and the three provider tables', () => {
    const tables = {
      ledger: 'suc1-aaaaaaaa-ledger',
      experiment_journal: 'suc1-aaaaaaaa-experiment-journal',
      control: 'suc1-aaaaaaaa-control',
    };
    assert.deepEqual(parseProviderEnvironment({ SUC_EXECUTION_KIND: 'RUN', SUC_EXECUTION_ID: RUN_ID, ...TABLES }), {
      ok: true,
      value: { deployment: { execution_kind: 'RUN', run_id: RUN_ID }, tables },
    });
    assert.deepEqual(
      parseProviderEnvironment({ SUC_EXECUTION_KIND: 'TRANSPORT_PROBE', SUC_EXECUTION_ID: PROBE_ID, ...TABLES }),
      { ok: true, value: { deployment: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_ID }, tables } },
    );
    assert.deepEqual(
      parseProviderEnvironment({
        SUC_EXECUTION_KIND: 'VARIANT_VALIDATION',
        SUC_EXECUTION_ID: VALIDATION_ID,
        ...TABLES,
      }),
      {
        ok: true,
        value: { deployment: { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: VALIDATION_ID }, tables },
      },
    );
  });

  it('names every missing or malformed variable', () => {
    assert.deepEqual(parseProviderEnvironment({ SUC_TABLE_LEDGER: ' ', SUC_TABLE_CONTROL: 'c' }), {
      ok: false,
      error:
        'provider environment invalid: SUC_EXECUTION_KIND=undefined; expected one of RUN, TRANSPORT_PROBE, VARIANT_VALIDATION; ' +
        'SUC_EXECUTION_ID=undefined; expected a lowercase RFC 4122 version-4 UUID; ' +
        'SUC_TABLE_LEDGER=" "; expected a non-empty table name; ' +
        'SUC_TABLE_EXPERIMENT_JOURNAL=undefined; expected a non-empty table name',
    });
  });

  it('refuses a lowercase kind or an uppercase id alone', () => {
    assert.deepEqual(parseProviderEnvironment({ SUC_EXECUTION_KIND: 'run', SUC_EXECUTION_ID: RUN_ID, ...TABLES }), {
      ok: false,
      error:
        'provider environment invalid: SUC_EXECUTION_KIND="run"; expected one of RUN, TRANSPORT_PROBE, VARIANT_VALIDATION',
    });
    assert.deepEqual(
      parseProviderEnvironment({ SUC_EXECUTION_KIND: 'RUN', SUC_EXECUTION_ID: RUN_ID.toUpperCase(), ...TABLES }),
      {
        ok: false,
        error: `provider environment invalid: SUC_EXECUTION_ID="${RUN_ID.toUpperCase()}"; expected a lowercase RFC 4122 version-4 UUID`,
      },
    );
  });
});
