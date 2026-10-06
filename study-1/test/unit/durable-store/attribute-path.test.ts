// Bounded attribute paths (WP-04 review round 2, Owner amendment A-05): a short member name is
// appended as it is, and a long one is quoted through the kernel's 200-character bound.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { memberPath } from '../../../src/durable-store/attribute-path.ts';

describe('memberPath', () => {
  it('appends a name of up to 200 characters as it is, inherited names included', () => {
    assert.equal(memberPath('$', 'state'), '$.state');
    assert.equal(memberPath('action.item', 'constructor'), 'action.item.constructor');
    assert.equal(memberPath('$', ''), '$.');
    const atLimit = 'x'.repeat(200);
    assert.equal(memberPath('$', atLimit), `$.${atLimit}`);
  });

  it('quotes a longer name, cut to 200 characters of JSON text', () => {
    assert.equal(memberPath('$', 'x'.repeat(201)), `$."${'x'.repeat(199)}…[truncated]`);
    const path = memberPath('$.a', 'y'.repeat(10_000_000));
    assert.equal(path, `$.a."${'y'.repeat(199)}…[truncated]`);
    assert.equal(memberPath('$', `${'q'.repeat(300)}"`), `$."${'q'.repeat(199)}…[truncated]`);
  });
});
