// The suite runner's verdict rules (design §12.1, D-33; testing rules 7 and 8).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SUITE_NAMES,
  e2eRefusal,
  evaluateSuiteRun,
  parseSuiteMinimums,
  sumSuiteMinimum,
} from '../../../tools/lib/suite-accounting.ts';
import type { SuiteCounts } from '../../../tools/lib/suite-accounting.ts';

const green: SuiteCounts = { tests: 5, passed: 5, failed: 0, cancelled: 0, skipped: 0, todo: 0 };

describe('parseSuiteMinimums', () => {
  it('accepts an object of catalogued suites to nonnegative integers', () => {
    assert.deepEqual(SUITE_NAMES, ['unit', 'contract', 'golden', 'integration', 'fuzz', 'e2e']);
    assert.deepEqual(parseSuiteMinimums('f.json', { unit: 7, fuzz: 0 }), { unit: 7, fuzz: 0 });
    assert.deepEqual(parseSuiteMinimums('f.json', {}), {});
  });

  it('refuses other shapes, naming the file and the expected shape', () => {
    for (const document of [null, [], 'x', 3]) {
      assert.throws(() => parseSuiteMinimums('f.json', document), {
        message: `f.json holds ${JSON.stringify(document)}; expected an object of suite name to minimum test count`,
      });
    }
    assert.throws(() => parseSuiteMinimums('f.json', { units: 1 }), {
      message: 'f.json names suite "units"; expected one of unit, contract, golden, integration, fuzz, e2e',
    });
    for (const minimum of [-1, 1.5, '3', null, 2 ** 53]) {
      assert.throws(() => parseSuiteMinimums('f.json', { unit: minimum }), {
        message: `f.json sets unit to ${JSON.stringify(minimum)}; expected a nonnegative integer`,
      });
    }
  });
});

describe('sumSuiteMinimum', () => {
  it('sums one suite over every feature file', () => {
    assert.equal(sumSuiteMinimum([{ unit: 3 }, { unit: 4, fuzz: 1 }, {}], 'unit'), 7);
    assert.equal(sumSuiteMinimum([{ unit: 3 }, { unit: 4, fuzz: 1 }], 'fuzz'), 1);
    assert.equal(sumSuiteMinimum([], 'unit'), 0);
  });

  it('has no minimum for an aggregate suite name', () => {
    assert.equal(sumSuiteMinimum([{ unit: 3 }], 'feature'), 0);
    assert.equal(sumSuiteMinimum([{ unit: 3 }], 'all'), 0);
  });
});

describe('evaluateSuiteRun', () => {
  it('passes a green run at or above the minimum', () => {
    assert.deepEqual(evaluateSuiteRun('unit', green, 5), { exitCode: 0, problems: [] });
    assert.deepEqual(evaluateSuiteRun('unit', green, 0), { exitCode: 0, problems: [] });
  });

  it('fails zero tests even when nothing failed', () => {
    const empty = { ...green, tests: 0, passed: 0 };
    assert.deepEqual(evaluateSuiteRun('golden', empty, 0), {
      exitCode: 1,
      problems: ['zero tests executed for suite golden; zero tests is not verification'],
    });
  });

  it('fails any failure or cancellation', () => {
    assert.deepEqual(evaluateSuiteRun('unit', { ...green, passed: 4, failed: 1 }, 0).problems, [
      '1 failed and 0 cancelled test(s); expected none',
    ]);
    assert.deepEqual(evaluateSuiteRun('unit', { ...green, passed: 4, cancelled: 1 }, 0).problems, [
      '0 failed and 1 cancelled test(s); expected none',
    ]);
  });

  it('fails any skip or todo', () => {
    assert.deepEqual(evaluateSuiteRun('unit', { ...green, skipped: 1 }, 0).problems, [
      '1 skipped and 0 todo test(s); expected none',
    ]);
    assert.deepEqual(evaluateSuiteRun('unit', { ...green, todo: 2 }, 0).problems, [
      '0 skipped and 2 todo test(s); expected none',
    ]);
  });

  it('fails a count below the summed minimum', () => {
    assert.deepEqual(evaluateSuiteRun('unit', green, 6), {
      exitCode: 1,
      problems: ['5 test(s) ran; expected at least the summed minimum 6'],
    });
  });
});

describe('e2eRefusal', () => {
  it('refuses unless both opt-in variables are non-empty', () => {
    assert.equal(e2eRefusal({ RUA_E2E_ENV: 'env.json', RUA_E2E_CONFIRM: 'run-1' }), undefined);
    const expectedShape = '; expected RUA_E2E_ENV=<environment-input file> and RUA_E2E_CONFIRM=<execution_id>';
    assert.equal(e2eRefusal({}), `e2e refuses to start: RUA_E2E_ENV and RUA_E2E_CONFIRM not set${expectedShape}`);
    assert.equal(
      e2eRefusal({ RUA_E2E_ENV: 'env.json' }),
      `e2e refuses to start: RUA_E2E_CONFIRM not set${expectedShape}`,
    );
    assert.equal(
      e2eRefusal({ RUA_E2E_ENV: '', RUA_E2E_CONFIRM: 'run-1' }),
      `e2e refuses to start: RUA_E2E_ENV not set${expectedShape}`,
    );
  });
});
