// The attribution window `[floor_hour(first_mutation_at), ceil_hour(cleanup_terminal_at))` and the
// half-open interval tests of design §8.17, over CUR's `YYYY-MM-DDTHH:mm:ssZ` instants.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attributionWindow,
  isContained,
  isDisjoint,
  parseCurInterval,
  parseCurTimestamp,
} from '../../../src/billing-amendment/usage-window.ts';
import type { UsageInterval } from '../../../src/billing-amendment/usage-window.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';

const at = (text: string): UtcMillis => text as UtcMillis;
const interval = (start: string, end: string): UsageInterval => ({ start: at(start), end: at(end) });

describe('parseCurTimestamp', () => {
  it('reads the CUR seconds form and the millisecond form', () => {
    assert.equal(parseCurTimestamp('2026-10-05T10:00:00Z'), '2026-10-05T10:00:00.000Z');
    assert.equal(parseCurTimestamp('2026-10-05T10:00:00.250Z'), '2026-10-05T10:00:00.250Z');
  });

  it('refuses other forms and impossible instants', () => {
    for (const text of [
      '',
      '2026-10-05',
      '2026-10-05 10:00:00',
      '2026-10-05T10:00:00',
      '2026-02-30T00:00:00Z',
      'x2026-10-05T10:00:00Z',
    ]) {
      assert.equal(parseCurTimestamp(text), undefined, text);
    }
  });
});

describe('parseCurInterval', () => {
  it('reads an interval whose end follows its start', () => {
    assert.deepEqual(parseCurInterval('2026-10-05T10:00:00Z', '2026-10-05T11:00:00Z'), {
      start: '2026-10-05T10:00:00.000Z',
      end: '2026-10-05T11:00:00.000Z',
    });
  });

  it('refuses an unreadable end, an unreadable start, and an empty or reversed interval', () => {
    assert.equal(parseCurInterval('2026-10-05T10:00:00Z', 'later'), undefined);
    assert.equal(parseCurInterval('earlier', '2026-10-05T10:00:00Z'), undefined);
    assert.equal(parseCurInterval('2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z'), undefined);
    assert.equal(parseCurInterval('2026-10-05T11:00:00Z', '2026-10-05T10:00:00Z'), undefined);
  });
});

describe('attributionWindow', () => {
  it('widens the mutation interval to whole hours', () => {
    assert.deepEqual(attributionWindow(at('2026-10-05T10:17:03.120Z'), at('2026-10-05T11:02:00.000Z')), {
      start: '2026-10-05T10:00:00.000Z',
      end: '2026-10-05T12:00:00.000Z',
    });
  });

  it('keeps instants already on the hour', () => {
    assert.deepEqual(attributionWindow(at('2026-10-05T10:00:00.000Z'), at('2026-10-05T11:00:00.000Z')), {
      start: '2026-10-05T10:00:00.000Z',
      end: '2026-10-05T11:00:00.000Z',
    });
  });

  it('moves a cleanup one millisecond past the hour to the next hour', () => {
    assert.deepEqual(attributionWindow(at('2026-10-05T10:59:59.999Z'), at('2026-10-05T11:00:00.001Z')), {
      start: '2026-10-05T10:00:00.000Z',
      end: '2026-10-05T12:00:00.000Z',
    });
  });
});

describe('isContained and isDisjoint', () => {
  const window = interval('2026-10-05T10:00:00.000Z', '2026-10-05T12:00:00.000Z');

  it('contains intervals inside the window, edges included', () => {
    assert.equal(isContained(interval('2026-10-05T10:00:00.000Z', '2026-10-05T12:00:00.000Z'), window), true);
    assert.equal(isContained(interval('2026-10-05T11:00:00.000Z', '2026-10-05T12:00:00.000Z'), window), true);
  });

  it('does not contain an interval that starts early or ends late', () => {
    assert.equal(isContained(interval('2026-10-05T09:59:59.999Z', '2026-10-05T11:00:00.000Z'), window), false);
    assert.equal(isContained(interval('2026-10-05T11:00:00.000Z', '2026-10-05T12:00:00.001Z'), window), false);
  });

  it('treats touching half-open intervals as disjoint and overlapping ones as not', () => {
    assert.equal(isDisjoint(interval('2026-10-05T09:00:00.000Z', '2026-10-05T10:00:00.000Z'), window), true);
    assert.equal(isDisjoint(interval('2026-10-05T12:00:00.000Z', '2026-10-05T13:00:00.000Z'), window), true);
    assert.equal(isDisjoint(interval('2026-10-05T09:00:00.000Z', '2026-10-05T10:00:00.001Z'), window), false);
    assert.equal(isDisjoint(interval('2026-10-05T11:59:59.999Z', '2026-10-05T13:00:00.000Z'), window), false);
  });
});
