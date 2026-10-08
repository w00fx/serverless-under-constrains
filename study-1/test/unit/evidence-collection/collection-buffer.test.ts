// The T8 buffer (design §10.2): a record's bytes under its layout key, or a reason and no file.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { keepRead, keepRecord } from '../../../src/evidence-collection/collection-buffer.ts';
import type { CollectionBuffer } from '../../../src/evidence-collection/collection-buffer.ts';

const emptyBuffer = (): CollectionBuffer => ({ files: [], failures: [] });

describe('collection buffer', () => {
  it('keeps a record as trial evidence by default, or with the given role', () => {
    const buffer = emptyBuffer();
    keepRecord(buffer, 'ledgerSnapshot', { a: 1 });
    keepRecord(buffer, 'executionConfiguration', { b: 2 }, 'supplementary');
    assert.deepEqual(
      buffer.files.map((file) => [file.key, file.role, new TextDecoder().decode(file.bytes)]),
      [
        ['ledgerSnapshot', 'trial_evidence', '{"a":1}\n'],
        ['executionConfiguration', 'supplementary', '{"b":2}\n'],
      ],
    );
    assert.deepEqual(buffer.failures, []);
  });

  it('records a reason and no file for a record JSON cannot represent', () => {
    const buffer = emptyBuffer();
    keepRecord(buffer, 'ledgerSnapshot', { amount: Infinity });
    assert.deepEqual(buffer.files, []);
    assert.deepEqual(
      buffer.failures.map((failure) => failure.code),
      ['RECORD_NOT_REPRESENTABLE'],
    );
  });

  it('keeps a successful read and records a failed one', () => {
    const buffer = emptyBuffer();
    keepRead(buffer, 'trialRegistration', { ok: true, value: { r: 1 } });
    keepRead(buffer, 'providerTrialConfiguration', {
      ok: false,
      error: { code: 'STATE_ITEM_ABSENT', subject: 's', detail: 'd' },
    });
    assert.deepEqual(
      buffer.files.map((file) => file.key),
      ['trialRegistration'],
    );
    assert.deepEqual(
      buffer.failures.map((failure) => failure.code),
      ['STATE_ITEM_ABSENT'],
    );
  });
});
