// Property tests of the README study block splice (the owner's item 4, testing rule 6: it rewrites
// a committed file between two markers). For any README text around one block and any block
// content, the splice keeps the text outside the markers byte for byte, puts the status right
// after the begin marker, and splicing the same status again changes nothing.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { STATUS_BEGIN, STATUS_END, withRepositoryStatus } from '../../../tools/lib/study-results-status.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

// Any text, including newlines and other HTML comments, that holds no marker of its own.
const free = fc.string({ unit: 'binary', maxLength: 40 }).filter((text) => !/study-results:(?:begin|end)/.test(text));
const status = free.map((text) => `${text}\n`);

describe('withRepositoryStatus over arbitrary README text', () => {
  it('keeps the text outside the markers and puts the status right after the begin marker', () => {
    fc.assert(
      fc.property(free, free, free, status, (before, old, after, next) => {
        const readme = `${before}${STATUS_BEGIN}${old}${STATUS_END}${after}`;
        assert.equal(withRepositoryStatus(readme, next), `${before}${STATUS_BEGIN}\n${next}${STATUS_END}${after}`);
      }),
      fuzzParameters(),
    );
  });

  it('changes nothing when the same status is spliced again', () => {
    fc.assert(
      fc.property(free, free, free, status, (before, old, after, next) => {
        const once = withRepositoryStatus(`${before}${STATUS_BEGIN}${old}${STATUS_END}${after}`, next);
        assert.equal(withRepositoryStatus(once, next), once);
      }),
      fuzzParameters(),
    );
  });
});
