// The e2e drivers' guards, offline (design §12.1 e2e row): a driver refuses to start without an
// environment input and a confirmed admitted execution id, reads string members only as strings,
// and refuses a confirmed execution whose package the operator has not admitted. Nothing here
// starts the CLI or reaches AWS.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  E2E_EVIDENCE_ROOT,
  STUDY_ROOT,
  admittedPackage,
  e2eSettings,
  stringMember,
} from '../../e2e/support/rua-operator.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';

const RUN_ID = '0b6d7a52-3c4e-4f80-9a1b-2c3d4e5f6a7b' as Uuid4;

describe('e2eSettings', () => {
  it('reads the environment input and the confirmed execution id', () => {
    assert.deepEqual(e2eSettings({ RUA_E2E_ENV: '/operator/env.json', RUA_E2E_CONFIRM: RUN_ID }), {
      environment_input: '/operator/env.json',
      confirmed_id: RUN_ID,
    });
  });

  it('refuses a missing input or a confirmation that is not an execution id, naming both', () => {
    for (const env of [{}, { RUA_E2E_ENV: 'env.json' }, { RUA_E2E_ENV: 'env.json', RUA_E2E_CONFIRM: 'yes' }]) {
      assert.throws(
        () => e2eSettings(env),
        /^Error: RUA_E2E_ENV=".*" RUA_E2E_CONFIRM=".*"; expected an environment-input file and the admitted execution_id \(lowercase UUIDv4\)$/,
      );
    }
  });
});

describe('stringMember and admittedPackage', () => {
  it('reads a string member and refuses any other value', () => {
    assert.equal(stringMember({ id: 'x' }, 'id'), 'x');
    assert.throws(() => stringMember({ id: 1 }, 'id'), /id is 1; expected a string member/);
    assert.throws(() => stringMember([], 'id'), /id is undefined; expected a string member/);
  });

  it('refuses an execution the operator has not admitted under the study evidence root', () => {
    assert.equal(E2E_EVIDENCE_ROOT, `${STUDY_ROOT}/evidence`);
    assert.throws(
      () => admittedPackage({ execution_kind: 'RUN', run_id: RUN_ID }),
      new RegExp(
        `runs/${RUN_ID}/admission/execution-manifest.json is absent; expected the operator to have admitted RUN`,
      ),
    );
  });
});
