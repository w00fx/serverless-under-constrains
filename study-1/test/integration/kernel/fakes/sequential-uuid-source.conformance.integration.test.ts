// Conformance of SequentialUuidSource with crypto.randomUUID() (RFC 9562 version 4), the
// production UuidSource: both issue canonical lowercase v4 ids that pass the BR-RUA-033 check.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isUuid4 } from '../../../../src/record-contract/identifiers.ts';
import type { UuidSource, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';

const subjects: readonly [string, () => UuidSource][] = [
  ['crypto.randomUUID', (): UuidSource => ({ next: (): Uuid4 => crypto.randomUUID() as Uuid4 })],
  ['SequentialUuidSource', (): UuidSource => new SequentialUuidSource('0000beef')],
];

for (const [name, create] of subjects) {
  describe(`uuid source contract: ${name}`, () => {
    it('issues distinct canonical lowercase version-4 ids', () => {
      const source = create();
      const ids = Array.from({ length: 1000 }, () => source.next());
      assert.deepEqual(
        ids.filter((id) => !isUuid4(id)),
        [],
      );
      assert.equal(new Set(ids).size, ids.length);
    });
  });
}

describe('SequentialUuidSource determinism and fault injection', () => {
  it('issues the same sequence for the same namespace and distinct ones across namespaces', () => {
    const first = new SequentialUuidSource();
    assert.equal(first.next(), '00000000-0000-4000-8000-000000000001');
    assert.equal(first.next(), '00000000-0000-4000-8000-000000000002');
    assert.equal(new SequentialUuidSource('0000000a').next(), '0000000a-0000-4000-8000-000000000001');
    assert.equal(first.issuedCount(), 2);
  });

  it('repeats the previous id once on request', () => {
    const source = new SequentialUuidSource();
    assert.throws(
      () => {
        source.repeatNext();
      },
      {
        message: 'repeatNext() before any id was issued; expected next() to have been called first',
      },
    );
    const id = source.next();
    source.repeatNext();
    assert.equal(source.next(), id);
    assert.equal(source.next(), '00000000-0000-4000-8000-000000000002');
    assert.equal(source.issuedCount(), 2);
  });

  it('refuses a namespace that would break the id format', () => {
    for (const namespace of ['ABCDEF01', '1234567', '123456789', 'g0000000']) {
      assert.throws(() => new SequentialUuidSource(namespace), {
        message: `namespace ${JSON.stringify(namespace)}; expected 8 lowercase hex digits`,
      });
    }
  });
});
