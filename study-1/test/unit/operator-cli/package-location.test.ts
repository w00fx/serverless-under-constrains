// A package operand is exactly `<evidence-root>/{runs|transport-probes|variant-validations}/<uuid4>`
// (design §7): the directory names the execution, and anything else is a usage error that quotes
// the operand and states the expected shape.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { locatePackage, locatePackageOfKind } from '../../../src/operator-cli/package-location.ts';

const ROOT = '/operator/evidence';
const ID = '0b6d7a52-3c4e-4f80-9a1b-2c3d4e5f6a7b';
const SHAPE = '<evidence-root>/{runs|transport-probes|variant-validations}/<lowercase uuid4>';

describe('locatePackage', () => {
  it('names the execution of each package kind', () => {
    assert.deepEqual(locatePackage(ROOT, `${ROOT}/runs/${ID}`), {
      ok: true,
      value: { execution_kind: 'RUN', run_id: ID },
    });
    assert.deepEqual(locatePackage(ROOT, `${ROOT}/transport-probes/${ID}`), {
      ok: true,
      value: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: ID },
    });
    assert.deepEqual(locatePackage(ROOT, `${ROOT}/variant-validations/${ID}/`), {
      ok: true,
      value: { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: ID },
    });
  });

  it('refuses every other directory with the operand and the expected shape', () => {
    const refused = [
      ROOT,
      `${ROOT}/runs`,
      `${ROOT}/runs/${ID}/admission`,
      `${ROOT}/trials/${ID}`,
      `${ROOT}/constructor/${ID}`,
      `${ROOT}/runs/${ID.toUpperCase()}`,
      `${ROOT}/runs/0b6d7a52-3c4e-1f80-9a1b-2c3d4e5f6a7b`,
      `/elsewhere/runs/${ID}`,
      `${ROOT}/../evidence-copy/runs/${ID}`,
    ];
    for (const path of refused) {
      assert.deepEqual(
        locatePackage(ROOT, path),
        {
          ok: false,
          error: {
            code: 'USAGE_ERROR',
            subject: 'operator-cli',
            detail: `package ${JSON.stringify(path)} is not a package directory; expected ${SHAPE}`,
          },
        },
        path,
      );
    }
  });
});

describe('locatePackageOfKind', () => {
  it('returns a package of the asked kind', () => {
    assert.deepEqual(locatePackageOfKind(ROOT, `${ROOT}/runs/${ID}`, 'RUN'), {
      ok: true,
      value: { execution_kind: 'RUN', run_id: ID },
    });
  });

  it('refuses a package of another kind', () => {
    const path = `${ROOT}/runs/${ID}`;
    assert.deepEqual(locatePackageOfKind(ROOT, path, 'TRANSPORT_PROBE'), {
      ok: false,
      error: {
        code: 'USAGE_ERROR',
        subject: 'operator-cli',
        detail: `package ${JSON.stringify(path)} is a RUN package; expected a TRANSPORT_PROBE package`,
      },
    });
  });

  it('passes a location failure through', () => {
    const located = locatePackageOfKind(ROOT, '/elsewhere', 'RUN');
    assert.equal(located.ok, false);
    assert.match(located.error.detail, /is not a package directory/);
  });
});
