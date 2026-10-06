// Journal partitions and item keys (design §9.3; addendum §2 warm-up partition): partition key
// `<execution_id>#<trial_id|probe|canary|warmup>` and sort key
// `<source>#<source_instance_id>#<source_sequence zero-padded to 12 digits>`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  executionIdOf,
  isSourceSequence,
  journalItemKey,
  journalPartitionKey,
  MAX_SOURCE_SEQUENCE,
  SEQUENCE_DIGITS,
} from '../../../src/event-journal/journal-scope.ts';
import {
  executionLevelScope,
  INSTANCE_ID,
  PROBE,
  PROBE_ID,
  RUN,
  RUN_ID,
  TRIAL_ID,
  TRIAL_SCOPE,
  VALIDATION,
  VALIDATION_ID,
} from '../../support/event-journal/journal-fixtures.ts';

describe('journal scope', () => {
  it('the execution id is the run, probe or validation id', () => {
    assert.equal(executionIdOf(RUN), RUN_ID);
    assert.equal(executionIdOf(PROBE), PROBE_ID);
    assert.equal(executionIdOf(VALIDATION), VALIDATION_ID);
  });

  it('table partition keys follow design §9.3 (trial, probe, canary) and addendum §2 (warmup)', () => {
    assert.equal(journalPartitionKey(TRIAL_SCOPE), `${RUN_ID}#${TRIAL_ID}`);
    assert.equal(journalPartitionKey(executionLevelScope(PROBE, 'probe')), `${PROBE_ID}#probe`);
    assert.equal(journalPartitionKey(executionLevelScope(RUN, 'canary')), `${RUN_ID}#canary`);
    assert.equal(journalPartitionKey(executionLevelScope(VALIDATION, 'warmup')), `${VALIDATION_ID}#warmup`);
  });

  it('the execution partition has an in-memory key only, outside design §9.3', () => {
    // Not a table partition: the execution-level journals are JSONL files (WP-05 deviation note).
    // The writer still orders their events by item key, so the key only has to be unique.
    assert.equal(journalPartitionKey(executionLevelScope(RUN, 'execution')), `${RUN_ID}#execution`);
  });

  it('the sort key pads the sequence to 12 digits so byte order is sequence order', () => {
    assert.deepEqual(journalItemKey(TRIAL_SCOPE, 'refund_provider', INSTANCE_ID, 1), {
      pk: `${RUN_ID}#${TRIAL_ID}`,
      sk: `refund_provider#${INSTANCE_ID}#000000000001`,
    });
    assert.equal(
      journalItemKey(TRIAL_SCOPE, 'conventional_caller', INSTANCE_ID, MAX_SOURCE_SEQUENCE).sk,
      `conventional_caller#${INSTANCE_ID}#999999999999`,
    );
    const nine = journalItemKey(TRIAL_SCOPE, 'runner', INSTANCE_ID, 9).sk;
    const ten = journalItemKey(TRIAL_SCOPE, 'runner', INSTANCE_ID, 10).sk;
    assert.ok(nine < ten);
    assert.equal(SEQUENCE_DIGITS, 12);
    assert.equal(MAX_SOURCE_SEQUENCE, 999_999_999_999);
  });

  it('accepts sequences from 1 to the 12-digit maximum only', () => {
    assert.equal(isSourceSequence(1), true);
    assert.equal(isSourceSequence(MAX_SOURCE_SEQUENCE), true);
    for (const invalid of [0, -1, 1.5, MAX_SOURCE_SEQUENCE + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(isSourceSequence(invalid), false, String(invalid));
      assert.throws(() => journalItemKey(TRIAL_SCOPE, 'runner', INSTANCE_ID, invalid), {
        name: 'RangeError',
        message: `source_sequence ${String(invalid)} of the item key of runner; expected an integer from 1 to 999999999999`,
      });
    }
  });
});
