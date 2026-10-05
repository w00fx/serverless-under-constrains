// Property target `foldEffectKnowledge` (design §12.5, WP-05): over arbitrary attempt
// sequences, UNKNOWN is absorbing (BR-RUA-004), every produced transition is permitted by the
// BR-RUA-022 table, and the confirmed-effect count never decreases. A reference model written
// from the rule text ("any ambiguous outcome is absorbing; a rejection establishes no effect
// only when no earlier success or ambiguity exists") must agree with the fold on every input.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  foldEffectKnowledge,
  isPermittedKnowledgeTransition,
  nextEffectKnowledge,
} from '../../../src/attempt-lifecycle/effect-knowledge.ts';
import type { OutcomeClass } from '../../../src/attempt-lifecycle/outcome-classification.ts';
import { OUTCOME_CLASSES } from '../../../src/attempt-lifecycle/outcome-classification.ts';
import type { EffectKnowledge } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const attemptClasses = fc.array(fc.constantFrom<OutcomeClass>(...OUTCOME_CLASSES), { maxLength: 40 });

// Confirmed effects per state; UNKNOWN can hide any number, so it ranks above every count.
const CONFIRMED_RANK: Readonly<Record<EffectKnowledge, number>> = {
  NOT_ATTEMPTED: 0,
  NO_EFFECT_CONFIRMED: 0,
  ONE_EFFECT_CONFIRMED: 1,
  MULTIPLE_EFFECTS_CONFIRMED: 2,
  UNKNOWN: 3,
};

function referenceKnowledge(classes: readonly OutcomeClass[]): EffectKnowledge {
  if (classes.includes('AMBIGUOUS')) {
    return 'UNKNOWN';
  }
  const successes = classes.filter((cls) => cls === 'SUCCESS').length;
  if (successes >= 2) {
    return 'MULTIPLE_EFFECTS_CONFIRMED';
  }
  if (successes === 1) {
    return 'ONE_EFFECT_CONFIRMED';
  }
  return classes.includes('REJECTION') ? 'NO_EFFECT_CONFIRMED' : 'NOT_ATTEMPTED';
}

describe('foldEffectKnowledge properties', () => {
  it('agrees with the reference model of BR-RUA-004 and BR-RUA-022', () => {
    fc.assert(
      fc.property(attemptClasses, (classes) => foldEffectKnowledge(classes) === referenceKnowledge(classes)),
      fuzzParameters(),
    );
  });

  it('UNKNOWN is absorbing, every step is permitted and confirmed effects never decrease', () => {
    fc.assert(
      fc.property(attemptClasses, (classes) => {
        let state: EffectKnowledge = 'NOT_ATTEMPTED';
        for (const cls of classes) {
          const next = nextEffectKnowledge(state, cls);
          assert.ok(isPermittedKnowledgeTransition(state, next), `${state} -> ${next} via ${cls}`);
          assert.ok(state !== 'UNKNOWN' || next === 'UNKNOWN', `left UNKNOWN via ${cls}`);
          assert.ok(CONFIRMED_RANK[next] >= CONFIRMED_RANK[state], `${state} -> ${next} lost effects`);
          state = next;
        }
        assert.equal(state, foldEffectKnowledge(classes));
      }),
      fuzzParameters(),
    );
  });

  it('a fold is the fold of its prefix continued by the remaining attempts', () => {
    fc.assert(
      fc.property(attemptClasses, attemptClasses, (prefix, suffix) => {
        const continued = suffix.reduce<EffectKnowledge>(nextEffectKnowledge, foldEffectKnowledge(prefix));
        assert.equal(foldEffectKnowledge([...prefix, ...suffix]), continued);
      }),
      fuzzParameters(),
    );
  });
});
