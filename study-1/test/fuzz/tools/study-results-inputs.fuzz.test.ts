// Property tests of the OR-RUA-001 table reader (close-out, the owner's item 3, testing rule 6: it
// parses the spec's Markdown). For any cell values, in any row order, with any text in other
// sections, it reads exactly the fixture's three rows; for any text at all, it either reads a
// fixture or refuses with its own message.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { financialFixtureOf } from '../../../tools/lib/study-results-inputs.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

// A cell value: any text without a backtick, a pipe or a line break.
const cell = fc.string({ unit: 'binary', maxLength: 12 }).filter((text) => !/[`|\n\r]/.test(text));
// A line of another section: any text that is not a heading.
const otherLine = fc
  .string({ unit: 'binary', maxLength: 30 })
  .filter((text) => !text.includes('\n') && !text.startsWith('#'));
const FIELDS = ['approved_amount_minor', 'captured_amount_minor', 'currency'] as const;

describe('financialFixtureOf over arbitrary specs', () => {
  it('reads the three rows under the OR-RUA-001 heading, in any order, whatever the other sections hold', () => {
    fc.assert(
      fc.property(
        fc.tuple(cell, cell, cell),
        fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
        fc.array(otherLine, { maxLength: 4 }),
        fc.array(otherLine, { maxLength: 4 }),
        (values, order, before, after) => {
          const rows = order.map((index) => `| \`${FIELDS[index] ?? ''}\` | \`${values[index] ?? ''}\` |`);
          const spec = [
            '## Before',
            ...before,
            ...rows,
            '### OR-RUA-001 — Financial fixture',
            ...rows,
            '## After',
            ...after,
            ...rows,
          ].join('\n');
          const [approved, captured, currency] = values;
          assert.deepEqual(financialFixtureOf(spec), {
            approved_amount_minor: approved,
            captured_amount_minor: captured,
            currency,
          });
        },
      ),
      fuzzParameters(),
    );
  });

  it('either reads a fixture or refuses with its own message, for any text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (text) => {
        try {
          financialFixtureOf(`### OR-RUA-001 \n${text}`);
        } catch (error) {
          assert.match((error as Error).message, /^the spec holds \d+ OR-RUA-001 rows for [a-z_]+; expected one /);
        }
      }),
      fuzzParameters(),
    );
  });
});
