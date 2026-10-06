// FinalizeRefusingJournal conformance (design §12.2): without a scripted refusal it passes the
// shared AppendOnlyFile suite the real binding passes; a refused finalize answers `failed` with
// its code and leaves the file open, as a failed `chmod` in `NodeAppendOnlyFile.finalize` does.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AppendOnlyFileUnderTest } from '../../../support/event-journal/append-only-file-conformance.ts';
import { describeAppendOnlyFileConformance } from '../../../support/event-journal/append-only-file-conformance.ts';
import { FinalizeRefusingJournal } from '../../../support/admission/finalize-refusing-journal.ts';

const encoder = new TextEncoder();

describeAppendOnlyFileConformance('FinalizeRefusingJournal', (): AppendOnlyFileUnderTest => {
  const file = new FinalizeRefusingJournal();
  return {
    file,
    path: (name) => `memory/${name}`,
    read: (path) => Promise.resolve(file.contents(path)),
    seedRaw: (path, bytes): Promise<void> => {
      file.seedRaw(path, bytes);
      return Promise.resolve();
    },
  };
});

describe('FinalizeRefusingJournal refusals', () => {
  it('fails the next finalize calls with the code and leaves the file appendable', async () => {
    const journal = new FinalizeRefusingJournal();
    await journal.append('j.jsonl', encoder.encode('1\n'));
    journal.refuseFinalize(2, 'EPERM');
    assert.deepEqual(await journal.finalize('j.jsonl'), { kind: 'failed', code: 'EPERM' });
    assert.deepEqual(await journal.finalize('j.jsonl'), { kind: 'failed', code: 'EPERM' });
    assert.equal(journal.isFinalized('j.jsonl'), false);
    assert.deepEqual(await journal.append('j.jsonl', encoder.encode('2\n')), { kind: 'appended' });
    assert.deepEqual(await journal.finalize('j.jsonl'), { kind: 'finalized' });
    assert.equal(journal.text('j.jsonl'), '1\n2\n');
  });

  it('refuses a count that is not a positive safe integer', () => {
    for (const count of [0, -1, 1.5]) {
      assert.throws(() => {
        new FinalizeRefusingJournal().refuseFinalize(count);
      }, RangeError);
    }
  });
});
