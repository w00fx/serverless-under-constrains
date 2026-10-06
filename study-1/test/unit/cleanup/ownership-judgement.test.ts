// One ownership decision per resource across surfaces (BR-RUA-050): the strongest evidence wins,
// baseline over direct deletion over the stack boundary over ambiguity; ties keep the first.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { judgeOwnership } from '../../../src/cleanup/ownership-judgement.ts';
import { resourceKey } from '../../../src/cleanup/resource-names.ts';
import { FUNCTION_RESOURCE_TYPE, TABLE_RESOURCE_TYPE } from '../../../src/cleanup/resource-types.ts';
import {
  discovered,
  NAMES,
  ownershipContext,
  STACK_ID,
  STACK_LISTING_TAGS,
  tagged,
} from '../../support/cleanup/cleanup-fixtures.ts';

const CONTEXT = ownershipContext();
const TABLE_KEY = resourceKey({ resource_type: TABLE_RESOURCE_TYPE, identifier: NAMES.controlTable });
const native = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables');
const listed = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'stack_resources', {
  tags: STACK_LISTING_TAGS,
  managed_by_stack_id: STACK_ID,
});
const untagged = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tag_index', { tags: tagged([]) });

describe('judgeOwnership', () => {
  it('prefers direct deletion evidence over the stack boundary, in either order', () => {
    for (const sightings of [
      [listed, native],
      [native, listed],
    ]) {
      const judged = judgeOwnership(sightings, CONTEXT).get(TABLE_KEY);
      assert.deepEqual(judged?.decision, { kind: 'owned', basis: 'resource_manifest_and_tags' });
      assert.equal(judged.resource.surface, 'tables');
    }
  });

  it('prefers the stack boundary over ambiguity', () => {
    const judged = judgeOwnership([untagged, listed], CONTEXT).get(TABLE_KEY);
    assert.deepEqual(judged?.decision, { kind: 'owned', basis: 'recorded_stack' });
  });

  it('keeps baseline exclusion over any ownership', () => {
    const baseline = ownershipContext();
    const context = { ...baseline, baseline: { names: [], name_prefixes: ['suc1-aaaaaaaa-control'] } };
    const judged = judgeOwnership([native, listed], context).get(TABLE_KEY);
    assert.deepEqual(judged?.decision, { kind: 'excluded_baseline' });
  });

  it('keeps the first of equally strong sightings and one entry per resource in first-sighting order', () => {
    const fn = discovered(FUNCTION_RESOURCE_TYPE, NAMES.providerFunction, 'functions');
    const fnTagIndex = { ...fn, surface: 'tag_index' as const };
    const judged = judgeOwnership([untagged, fnTagIndex, fn, { ...untagged, surface: 'tables' as const }], CONTEXT);
    assert.deepEqual([...judged.keys()], [TABLE_KEY, resourceKey(fn)]);
    assert.equal(judged.get(resourceKey(fn))?.resource.surface, 'tag_index');
    assert.equal(judged.get(TABLE_KEY)?.resource.surface, 'tag_index');
    assert.equal(judged.get(TABLE_KEY)?.decision.kind, 'ambiguous');
  });
});
