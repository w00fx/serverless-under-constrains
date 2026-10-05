// The probe caller function's environment (design §9.4, §9.6).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROBE_CALLER_ENVIRONMENT_VARIABLES,
  parseProbeCallerEnvironment,
} from '../../../src/transport-probe-caller/probe-caller-environment.ts';
import { PROBE, PROBE_ID } from '../refund-provider/support/provider-fixtures.ts';

const VALID = {
  SUC_EXECUTION_KIND: 'TRANSPORT_PROBE',
  SUC_EXECUTION_ID: PROBE_ID,
  SUC_TABLE_CALLER_JOURNAL: 'suc1-aaaaaaaa-caller-journal',
  SUC_PROVIDER_FUNCTION_NAME: 'SucRua-probe-aaaaaaaa-ExperimentCoreProvider',
  SUC_PROVIDER_QUALIFIER: '12',
};

describe('parseProbeCallerEnvironment', () => {
  it('names the five variables it reads', () => {
    assert.deepEqual(PROBE_CALLER_ENVIRONMENT_VARIABLES, {
      execution_kind: 'SUC_EXECUTION_KIND',
      execution_id: 'SUC_EXECUTION_ID',
      caller_journal: 'SUC_TABLE_CALLER_JOURNAL',
      provider_function_name: 'SUC_PROVIDER_FUNCTION_NAME',
      provider_qualifier: 'SUC_PROVIDER_QUALIFIER',
    });
  });

  it('reads the probe deployment, its caller journal and the provider version', () => {
    assert.deepEqual(parseProbeCallerEnvironment(VALID), {
      ok: true,
      value: {
        deployment: PROBE,
        caller_journal_table: 'suc1-aaaaaaaa-caller-journal',
        provider_function_name: 'SucRua-probe-aaaaaaaa-ExperimentCoreProvider',
        provider_qualifier: '12',
      },
    });
  });

  it('names every missing or malformed variable at once', () => {
    assert.deepEqual(parseProbeCallerEnvironment({ SUC_EXECUTION_KIND: 'RUN', SUC_PROVIDER_QUALIFIER: '$LATEST' }), {
      ok: false,
      error:
        'probe caller environment invalid: SUC_EXECUTION_KIND="RUN"; expected TRANSPORT_PROBE; ' +
        'SUC_EXECUTION_ID=undefined; expected a lowercase RFC 4122 version-4 UUID; ' +
        'SUC_TABLE_CALLER_JOURNAL=undefined; expected a non-empty table name; ' +
        'SUC_PROVIDER_FUNCTION_NAME=undefined; expected a non-empty function name; ' +
        'SUC_PROVIDER_QUALIFIER="$LATEST"; expected a published version number',
    });
  });

  it('refuses a single bad variable among valid ones', () => {
    for (const [name, value] of [
      ['SUC_EXECUTION_KIND', 'VARIANT_VALIDATION'],
      ['SUC_EXECUTION_ID', 'probe'],
      ['SUC_TABLE_CALLER_JOURNAL', ' '],
      ['SUC_PROVIDER_FUNCTION_NAME', ''],
      ['SUC_PROVIDER_QUALIFIER', '07'],
      ['SUC_PROVIDER_QUALIFIER', undefined],
    ] as const) {
      const result = parseProbeCallerEnvironment({ ...VALID, [name]: value });
      assert.equal(result.ok, false, `${name}=${String(value)}`);
      assert.match(result.error, new RegExp(`^probe caller environment invalid: ${name.replace('$', '\\$')}=`));
    }
  });
});
