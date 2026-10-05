// The controller function's environment (design §9.4, §9.6).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONTROLLER_ENVIRONMENT_VARIABLES,
  parseControllerEnvironment,
} from '../../../src/treatment-controller/controller-environment.ts';
import { PROBE, PROBE_ID, RUN, RUN_ID, VALIDATION, VALIDATION_ID } from './support/controller-fixtures.ts';

const TABLES = {
  SUC_TABLE_EXPERIMENT_JOURNAL: 'suc1-aaaaaaaa-experiment-journal',
  SUC_TABLE_CONTROL: 'suc1-aaaaaaaa-control',
};

describe('parseControllerEnvironment', () => {
  it('names the four variables it reads', () => {
    assert.deepEqual(CONTROLLER_ENVIRONMENT_VARIABLES, {
      execution_kind: 'SUC_EXECUTION_KIND',
      execution_id: 'SUC_EXECUTION_ID',
      experiment_journal: 'SUC_TABLE_EXPERIMENT_JOURNAL',
      control: 'SUC_TABLE_CONTROL',
    });
  });

  it('reads the deployment of every execution kind and the two table names', () => {
    const cases = [
      ['RUN', RUN_ID, RUN],
      ['TRANSPORT_PROBE', PROBE_ID, PROBE],
      ['VARIANT_VALIDATION', VALIDATION_ID, VALIDATION],
    ] as const;
    for (const [kind, id, deployment] of cases) {
      assert.deepEqual(parseControllerEnvironment({ SUC_EXECUTION_KIND: kind, SUC_EXECUTION_ID: id, ...TABLES }), {
        ok: true,
        value: {
          deployment,
          tables: { experiment_journal: 'suc1-aaaaaaaa-experiment-journal', control: 'suc1-aaaaaaaa-control' },
        },
      });
    }
  });

  it('names every missing or malformed variable at once', () => {
    assert.deepEqual(parseControllerEnvironment({ SUC_EXECUTION_KIND: 'PROD', SUC_TABLE_CONTROL: '  ' }), {
      ok: false,
      error:
        'controller environment invalid: SUC_EXECUTION_KIND="PROD"; expected one of RUN, TRANSPORT_PROBE, VARIANT_VALIDATION; ' +
        'SUC_EXECUTION_ID=undefined; expected a lowercase RFC 4122 version-4 UUID; ' +
        'SUC_TABLE_EXPERIMENT_JOURNAL=undefined; expected a non-empty table name; ' +
        'SUC_TABLE_CONTROL="  "; expected a non-empty table name',
    });
  });

  it('refuses a single bad variable among valid ones', () => {
    const valid = { SUC_EXECUTION_KIND: 'RUN', SUC_EXECUTION_ID: RUN_ID, ...TABLES };
    for (const [name, value] of [
      ['SUC_EXECUTION_KIND', undefined],
      ['SUC_EXECUTION_ID', RUN_ID.toUpperCase()],
      ['SUC_TABLE_EXPERIMENT_JOURNAL', ''],
      ['SUC_TABLE_CONTROL', undefined],
    ] as const) {
      const result = parseControllerEnvironment({ ...valid, [name]: value });
      assert.equal(result.ok, false, name);
      assert.match(result.error, new RegExp(`^controller environment invalid: ${name}=`));
    }
  });
});
