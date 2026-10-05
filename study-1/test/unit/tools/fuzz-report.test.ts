// Fuzz campaign reports (design §12.5, testing rule 7).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { buildFuzzReport, fuzzTargetName, parseFastCheckFailure } from '../../../tools/lib/fuzz-report.ts';

const OBSERVED_MESSAGE =
  'Property failed after 7 tests\n{ seed: -42, path: "6:1:0", endOnFailure: true }\nCounterexample: [50]\nShrunk 28 time(s)\nGot error: boom';

describe('parseFastCheckFailure', () => {
  it('extracts the replay data from a fast-check failure', () => {
    assert.deepEqual(parseFastCheckFailure(OBSERVED_MESSAGE), {
      tests_run: 7,
      seed: -42,
      path: '6:1:0',
      counterexample: '[50]',
    });
  });

  it('extracts the replay data from a real fast-check failure', () => {
    let message = '';
    try {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1000 }), (value) => value < 50),
        { seed: 1234 },
      );
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    const parsed = parseFastCheckFailure(message);
    assert.equal(parsed.seed, 1234);
    assert.equal(parsed.counterexample, '[50]');
    assert.ok((parsed.tests_run ?? 0) > 0);
    assert.match(parsed.path ?? '', /^\d+(:\d+)*$/);
  });

  it('omits what the message does not contain', () => {
    assert.deepEqual(parseFastCheckFailure('assertion failed'), {});
    assert.deepEqual(parseFastCheckFailure('x\nCounterexample: "a"'), { counterexample: '"a"' });
    assert.deepEqual(parseFastCheckFailure('prefix Counterexample: [1]'), {});
  });
});

describe('buildFuzzReport', () => {
  it('counts properties, executed cases, seeds and counterexamples across campaigns', () => {
    const report = buildFuzzReport({
      tool: 'fast-check@4.10.2',
      target: 'record-contract/jsonl',
      runs: 100,
      campaigns: [
        { seed: 11, passed: 3, failures: [] },
        { seed: 22, passed: 2, failures: [{ test: 'round-trips', message: OBSERVED_MESSAGE }] },
      ],
    });
    assert.deepEqual(report, {
      tool: 'fast-check@4.10.2',
      target: 'record-contract/jsonl',
      mode: 'generative',
      runs: 100,
      seeds: [11, 22],
      properties: 6,
      executed: 507,
      failures: 1,
      counterexamples: [
        { test: 'round-trips', campaign_seed: 22, tests_run: 7, seed: -42, path: '6:1:0', counterexample: '[50]' },
      ],
    });
  });

  it('counts a non-fast-check failure as zero executed cases', () => {
    const report = buildFuzzReport({
      tool: 't',
      target: 'x/y',
      runs: 10,
      campaigns: [{ seed: 1, passed: 0, failures: [{ test: 'a', message: 'TypeError' }] }],
    });
    assert.equal(report.executed, 0);
    assert.equal(report.properties, 1);
    assert.deepEqual(report.counterexamples, [{ test: 'a', campaign_seed: 1 }]);
  });

  it('reports zero properties for an empty campaign list', () => {
    const report = buildFuzzReport({ tool: 't', target: 'x/y', runs: 10, campaigns: [] });
    assert.deepEqual([report.properties, report.executed, report.failures, report.seeds], [0, 0, 0, []]);
  });
});

describe('fuzzTargetName', () => {
  it('names a target after its feature and file', () => {
    assert.equal(fuzzTargetName('test/fuzz/record-contract/jsonl.fuzz.test.ts'), 'record-contract/jsonl');
    assert.equal(
      fuzzTargetName('/abs/study-1/test/fuzz/evidence-package/package-index.fuzz.test.ts'),
      'evidence-package/package-index',
    );
  });

  it('refuses a file outside test/fuzz', () => {
    for (const file of [
      'test/unit/x.fuzz.test.ts',
      'test/fuzz/x.test.ts',
      'mytest/fuzz/a/b.fuzz.test.ts',
      'test/fuzz/a/b.fuzz.test.ts.bak',
    ]) {
      assert.throws(() => fuzzTargetName(file), {
        message: `fuzz file ${JSON.stringify(file)}; expected test/fuzz/<feature>/<name>.fuzz.test.ts`,
      });
    }
  });
});
