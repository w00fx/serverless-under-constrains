// The mutation-target policy copied into the coverage and mutation configs (design §15.4).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyMutationTargets,
  parseMutationTargetPolicy,
  qualityConfigDrift,
  strykerMutatePatterns,
} from '../../../tools/lib/quality-config.ts';

const policy = {
  include: ['src/**/*.ts', 'tools/lib/**/*.ts'],
  exclude: ['src/**/aws/**'],
  type_only: 'excluded',
} as const;

describe('parseMutationTargetPolicy', () => {
  it('reads include and exclude glob lists and the A-10 type-only exclusion', () => {
    assert.deepEqual(parseMutationTargetPolicy({ ...policy, $comment: 'D-13' }), policy);
    assert.deepEqual(parseMutationTargetPolicy({ include: ['a'], exclude: [], type_only: 'excluded' }), {
      include: ['a'],
      exclude: [],
      type_only: 'excluded',
    });
  });

  it('refuses an empty include, non-string patterns, missing lists and any other type-only treatment', () => {
    for (const document of [
      null,
      {},
      { include: [], exclude: [], type_only: 'excluded' },
      { include: ['a'], type_only: 'excluded' },
      { include: ['a'], exclude: [1], type_only: 'excluded' },
      { include: [''], exclude: [], type_only: 'excluded' },
      { include: 'a', exclude: [], type_only: 'excluded' },
      // Human decision A-10: the policy must record that type-only modules are excluded.
      { include: ['a'], exclude: [] },
      { include: ['a'], exclude: [], type_only: 'included' },
      { include: ['a'], exclude: [], type_only: true },
    ]) {
      assert.throws(() => parseMutationTargetPolicy(document), {
        message: `mutation-target policy is ${JSON.stringify(document)}; expected { include: [glob, ...] (non-empty), exclude: [glob, ...], type_only: "excluded" (human decision A-10) }`,
      });
    }
  });
});

describe('applying the policy', () => {
  it('builds the Stryker mutate list with negated exclusions', () => {
    assert.deepEqual(strykerMutatePatterns(policy), ['src/**/*.ts', 'tools/lib/**/*.ts', '!src/**/aws/**']);
  });

  it('sets only the target fields and keeps the rest', () => {
    const { c8, stryker } = applyMutationTargets(policy, { all: true, include: ['old'] }, { concurrency: 4 });
    assert.deepEqual(c8, { all: true, include: policy.include, exclude: policy.exclude });
    assert.deepEqual(stryker, { concurrency: 4, mutate: ['src/**/*.ts', 'tools/lib/**/*.ts', '!src/**/aws/**'] });
  });

  it('reports each drifted field with the value found and the value required', () => {
    const { c8, stryker } = applyMutationTargets(policy, {}, {});
    assert.deepEqual(qualityConfigDrift(policy, c8, stryker), []);
    assert.deepEqual(qualityConfigDrift(policy, { ...c8, include: ['src/**/*.ts'] }, stryker), [
      '.c8rc.json include is ["src/**/*.ts"]; expected ["src/**/*.ts","tools/lib/**/*.ts"] from quality/mutation-targets.json',
    ]);
    assert.deepEqual(qualityConfigDrift(policy, { ...c8, exclude: [] }, { mutate: ['src/**/*.ts'] }), [
      '.c8rc.json exclude is []; expected ["src/**/aws/**"] from quality/mutation-targets.json',
      'stryker.config.json mutate is ["src/**/*.ts"]; expected ["src/**/*.ts","tools/lib/**/*.ts","!src/**/aws/**"] from quality/mutation-targets.json',
    ]);
    assert.deepEqual(qualityConfigDrift(policy, {}, stryker), [
      '.c8rc.json include is undefined; expected ["src/**/*.ts","tools/lib/**/*.ts"] from quality/mutation-targets.json',
      '.c8rc.json exclude is undefined; expected ["src/**/aws/**"] from quality/mutation-targets.json',
    ]);
  });
});
