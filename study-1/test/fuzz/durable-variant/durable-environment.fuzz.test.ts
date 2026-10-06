// Property-based tests of the Durable caller's environment reader (testing rule 6): the Lambda
// environment is configuration the construct writes, but the reader still refuses anything else
// with every problem named, reads only own properties (A-05), and never throws.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  DURABLE_ENVIRONMENT_VARIABLES,
  parseDurableEnvironment,
} from '../../../src/durable-variant/durable-environment.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
type VariableName = (typeof DURABLE_ENVIRONMENT_VARIABLES)[keyof typeof DURABLE_ENVIRONMENT_VARIABLES];

const names = DURABLE_ENVIRONMENT_VARIABLES;

const candidates: Readonly<Record<VariableName, fc.Arbitrary<string | undefined>>> = {
  [names.execution_kind]: fc.oneof(
    fc.constantFrom('RUN', 'VARIANT_VALIDATION', 'TRANSPORT_PROBE', 'run', ''),
    fc.string(),
  ),
  [names.execution_id]: fc.oneof(fc.uuid({ version: 4 }), fc.uuid(), fc.string({ maxLength: 40 })),
  [names.caller_journal]: fc.oneof(fc.constantFrom('suc1-x-caller-journal', '', '  '), fc.string({ maxLength: 8 })),
  [names.trial_registry]: fc.oneof(fc.constantFrom('suc1-x-trial-registry', '', ' '), fc.string({ maxLength: 8 })),
  [names.provider_function_name]: fc.oneof(fc.constantFrom('suc1-provider', ''), fc.string({ maxLength: 8 })),
  [names.provider_qualifier]: fc.oneof(
    fc.integer({ min: 1, max: 10_000 }).map(String),
    fc.constantFrom('$LATEST', 'live', '0', '01', '1.0', ''),
    fc.string({ maxLength: 4 }),
  ),
  [names.variant_id]: fc.oneof(fc.constantFrom('durable', 'conventional', 'Durable', ''), fc.string({ maxLength: 8 })),
};

const environmentArbitrary = fc.record({
  values: fc.record(candidates, { requiredKeys: [] }),
  inherited: fc.constantFrom<VariableName | 'none'>('none', ...Object.values(names)),
  extra: fc.dictionary(fc.string({ maxLength: 6 }), fc.string({ maxLength: 6 }), { maxKeys: 2 }),
});

function accepts(name: VariableName, value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  switch (name) {
    case names.execution_kind:
      return value === 'RUN' || value === 'VARIANT_VALIDATION';
    case names.execution_id:
      return UUID4.test(value);
    case names.provider_qualifier:
      return /^[1-9][0-9]*$/u.test(value);
    case names.variant_id:
      return value === 'durable';
    case names.caller_journal:
    case names.trial_registry:
    case names.provider_function_name:
      return value.trim() !== '';
  }
}

describe('parseDurableEnvironment properties', () => {
  it('accepts exactly the environments whose seven own variables are well formed, naming every bad one', () => {
    fc.assert(
      fc.property(environmentArbitrary, ({ values, inherited, extra }) => {
        const own: Record<string, string | undefined> = { ...extra, ...values };
        const env: Record<string, string | undefined> =
          inherited === 'none' ? own : Object.assign(Object.create({ [inherited]: own[inherited] }) as object, own);
        if (inherited !== 'none') {
          Reflect.deleteProperty(env, inherited);
        }
        const parsed = parseDurableEnvironment(env);
        const bad = Object.values(names).filter((name) => name === inherited || !accepts(name, values[name]));
        assert.equal(parsed.ok, bad.length === 0, parsed.ok ? 'accepted' : parsed.error);
        if (!parsed.ok) {
          assert.match(parsed.error, /^durable caller environment invalid: /u);
          for (const name of bad) {
            assert.match(parsed.error, new RegExp(`(?:: |; )${name} `, 'u'));
          }
          return;
        }
        const id = values[names.execution_id];
        assert.deepEqual(
          parsed.value.deployment,
          values[names.execution_kind] === 'RUN'
            ? { execution_kind: 'RUN', run_id: id }
            : { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: id },
        );
        assert.equal(parsed.value.provider_qualifier, values[names.provider_qualifier]);
      }),
      fuzzParameters(),
    );
  });
});
