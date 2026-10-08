// AC-RUA-043: effect knowledge follows the BR-RUA-022 transition table. Every expected value
// below is copied from the spec table (study-1/specs/rua/refund-under-ambiguous-outcome.md,
// BR-RUA-022), never from the implementation: 20 cells (5 states x 4 outcome classes), the 13
// permitted (from, to) pairs those cells produce and the 12 refused pairs.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EFFECT_KNOWLEDGE_TABLE,
  INITIAL_EFFECT_KNOWLEDGE,
  isPermittedKnowledgeTransition,
  nextEffectKnowledge,
} from '../../../src/attempt-lifecycle/effect-knowledge.ts';
import type { OutcomeClass } from '../../../src/attempt-lifecycle/outcome-classification.ts';
import { OUTCOME_CLASSES } from '../../../src/attempt-lifecycle/outcome-classification.ts';
import type { EffectKnowledge } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { EFFECT_KNOWLEDGE_STATES } from '../../../src/record-contract/records/group-b/vocabulary.ts';

// | From state | Pre-dispatch failure | Rejection | Success | Ambiguous |
const SPEC_CELLS: readonly (readonly [EffectKnowledge, OutcomeClass, EffectKnowledge])[] = [
  ['NOT_ATTEMPTED', 'PRE_DISPATCH_FAILURE', 'NOT_ATTEMPTED'],
  ['NOT_ATTEMPTED', 'REJECTION', 'NO_EFFECT_CONFIRMED'],
  ['NOT_ATTEMPTED', 'SUCCESS', 'ONE_EFFECT_CONFIRMED'],
  ['NOT_ATTEMPTED', 'AMBIGUOUS', 'UNKNOWN'],
  ['NO_EFFECT_CONFIRMED', 'PRE_DISPATCH_FAILURE', 'NO_EFFECT_CONFIRMED'],
  ['NO_EFFECT_CONFIRMED', 'REJECTION', 'NO_EFFECT_CONFIRMED'],
  ['NO_EFFECT_CONFIRMED', 'SUCCESS', 'ONE_EFFECT_CONFIRMED'],
  ['NO_EFFECT_CONFIRMED', 'AMBIGUOUS', 'UNKNOWN'],
  ['ONE_EFFECT_CONFIRMED', 'PRE_DISPATCH_FAILURE', 'ONE_EFFECT_CONFIRMED'],
  ['ONE_EFFECT_CONFIRMED', 'REJECTION', 'ONE_EFFECT_CONFIRMED'],
  ['ONE_EFFECT_CONFIRMED', 'SUCCESS', 'MULTIPLE_EFFECTS_CONFIRMED'],
  ['ONE_EFFECT_CONFIRMED', 'AMBIGUOUS', 'UNKNOWN'],
  ['MULTIPLE_EFFECTS_CONFIRMED', 'PRE_DISPATCH_FAILURE', 'MULTIPLE_EFFECTS_CONFIRMED'],
  ['MULTIPLE_EFFECTS_CONFIRMED', 'REJECTION', 'MULTIPLE_EFFECTS_CONFIRMED'],
  ['MULTIPLE_EFFECTS_CONFIRMED', 'SUCCESS', 'MULTIPLE_EFFECTS_CONFIRMED'],
  ['MULTIPLE_EFFECTS_CONFIRMED', 'AMBIGUOUS', 'UNKNOWN'],
  ['UNKNOWN', 'PRE_DISPATCH_FAILURE', 'UNKNOWN'],
  ['UNKNOWN', 'REJECTION', 'UNKNOWN'],
  ['UNKNOWN', 'SUCCESS', 'UNKNOWN'],
  ['UNKNOWN', 'AMBIGUOUS', 'UNKNOWN'],
];

// "Every other transition is refused: nothing leaves UNKNOWN, and knowledge never moves back
// toward fewer confirmed effects."
const SPEC_REFUSED: readonly (readonly [EffectKnowledge, EffectKnowledge])[] = [
  ['NOT_ATTEMPTED', 'MULTIPLE_EFFECTS_CONFIRMED'],
  ['NO_EFFECT_CONFIRMED', 'NOT_ATTEMPTED'],
  ['NO_EFFECT_CONFIRMED', 'MULTIPLE_EFFECTS_CONFIRMED'],
  ['ONE_EFFECT_CONFIRMED', 'NOT_ATTEMPTED'],
  ['ONE_EFFECT_CONFIRMED', 'NO_EFFECT_CONFIRMED'],
  ['MULTIPLE_EFFECTS_CONFIRMED', 'NOT_ATTEMPTED'],
  ['MULTIPLE_EFFECTS_CONFIRMED', 'NO_EFFECT_CONFIRMED'],
  ['MULTIPLE_EFFECTS_CONFIRMED', 'ONE_EFFECT_CONFIRMED'],
  ['UNKNOWN', 'NOT_ATTEMPTED'],
  ['UNKNOWN', 'NO_EFFECT_CONFIRMED'],
  ['UNKNOWN', 'ONE_EFFECT_CONFIRMED'],
  ['UNKNOWN', 'MULTIPLE_EFFECTS_CONFIRMED'],
];

const SPEC_PERMITTED: readonly (readonly [EffectKnowledge, EffectKnowledge])[] = [
  ['NOT_ATTEMPTED', 'NOT_ATTEMPTED'],
  ['NOT_ATTEMPTED', 'NO_EFFECT_CONFIRMED'],
  ['NOT_ATTEMPTED', 'ONE_EFFECT_CONFIRMED'],
  ['NOT_ATTEMPTED', 'UNKNOWN'],
  ['NO_EFFECT_CONFIRMED', 'NO_EFFECT_CONFIRMED'],
  ['NO_EFFECT_CONFIRMED', 'ONE_EFFECT_CONFIRMED'],
  ['NO_EFFECT_CONFIRMED', 'UNKNOWN'],
  ['ONE_EFFECT_CONFIRMED', 'ONE_EFFECT_CONFIRMED'],
  ['ONE_EFFECT_CONFIRMED', 'MULTIPLE_EFFECTS_CONFIRMED'],
  ['ONE_EFFECT_CONFIRMED', 'UNKNOWN'],
  ['MULTIPLE_EFFECTS_CONFIRMED', 'MULTIPLE_EFFECTS_CONFIRMED'],
  ['MULTIPLE_EFFECTS_CONFIRMED', 'UNKNOWN'],
  ['UNKNOWN', 'UNKNOWN'],
];

describe('AC-RUA-043 effect knowledge follows the transition table', () => {
  for (const [from, cls, expected] of SPEC_CELLS) {
    it(`cell ${from} x ${cls} -> ${expected}`, () => {
      assert.equal(nextEffectKnowledge(from, cls), expected);
    });
  }

  for (const [from, to] of SPEC_REFUSED) {
    it(`refused ${from} -> ${to}`, () => {
      assert.equal(isPermittedKnowledgeTransition(from, to), false);
    });
  }

  for (const [from, to] of SPEC_PERMITTED) {
    it(`permitted ${from} -> ${to}`, () => {
      assert.equal(isPermittedKnowledgeTransition(from, to), true);
    });
  }

  it('the table has exactly 20 cells, and permitted plus refused pairs cover all 25 (from, to) pairs', () => {
    assert.equal(SPEC_CELLS.length, EFFECT_KNOWLEDGE_STATES.length * OUTCOME_CLASSES.length);
    const covered = new Set([...SPEC_PERMITTED, ...SPEC_REFUSED].map(([from, to]) => `${from}>${to}`));
    assert.equal(covered.size, 25);
    assert.equal(SPEC_REFUSED.length, 12);
    assert.equal(Object.keys(EFFECT_KNOWLEDGE_TABLE).length, 5);
  });

  it('a request starts NOT_ATTEMPTED', () => {
    assert.equal(INITIAL_EFFECT_KNOWLEDGE, 'NOT_ATTEMPTED');
  });
});
