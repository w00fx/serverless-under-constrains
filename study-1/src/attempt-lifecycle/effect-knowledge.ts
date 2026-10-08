// BR-RUA-022 effect-knowledge state model and BR-RUA-004 absorbing `UNKNOWN`.
//
// The table is the spec's BR-RUA-022 transition table, ratified in 5d16bfe; before that it was
// a [PROPOSED] item, approved as working authority by the addendum §1. Every cell is written
// here literally (5 states x 4 outcome classes); the set
// of permitted transitions is exactly the set of cells, so the 12 remaining (from, to) pairs
// are refused: nothing leaves `UNKNOWN`, and knowledge never moves back toward fewer
// confirmed effects.

import type { EffectKnowledge } from '../record-contract/records/group-b/vocabulary.ts';
import type { OutcomeClass } from './outcome-classification.ts';

/** BR-RUA-022 transition table: `EFFECT_KNOWLEDGE_TABLE[from][outcomeClass]`. */
export const EFFECT_KNOWLEDGE_TABLE: Readonly<
  Record<EffectKnowledge, Readonly<Record<OutcomeClass, EffectKnowledge>>>
> = {
  NOT_ATTEMPTED: {
    PRE_DISPATCH_FAILURE: 'NOT_ATTEMPTED',
    REJECTION: 'NO_EFFECT_CONFIRMED',
    SUCCESS: 'ONE_EFFECT_CONFIRMED',
    AMBIGUOUS: 'UNKNOWN',
  },
  NO_EFFECT_CONFIRMED: {
    PRE_DISPATCH_FAILURE: 'NO_EFFECT_CONFIRMED',
    REJECTION: 'NO_EFFECT_CONFIRMED',
    SUCCESS: 'ONE_EFFECT_CONFIRMED',
    AMBIGUOUS: 'UNKNOWN',
  },
  ONE_EFFECT_CONFIRMED: {
    PRE_DISPATCH_FAILURE: 'ONE_EFFECT_CONFIRMED',
    REJECTION: 'ONE_EFFECT_CONFIRMED',
    SUCCESS: 'MULTIPLE_EFFECTS_CONFIRMED',
    AMBIGUOUS: 'UNKNOWN',
  },
  MULTIPLE_EFFECTS_CONFIRMED: {
    PRE_DISPATCH_FAILURE: 'MULTIPLE_EFFECTS_CONFIRMED',
    REJECTION: 'MULTIPLE_EFFECTS_CONFIRMED',
    SUCCESS: 'MULTIPLE_EFFECTS_CONFIRMED',
    AMBIGUOUS: 'UNKNOWN',
  },
  UNKNOWN: {
    PRE_DISPATCH_FAILURE: 'UNKNOWN',
    REJECTION: 'UNKNOWN',
    SUCCESS: 'UNKNOWN',
    AMBIGUOUS: 'UNKNOWN',
  },
};

/** A request with no attempt yet, and a first action that failed before dispatch (BR-RUA-022). */
export const INITIAL_EFFECT_KNOWLEDGE: EffectKnowledge = 'NOT_ATTEMPTED';

/**
 * The knowledge after one more attempt of class `cls`: the table cell `(from, cls)`.
 *
 * @example
 * nextEffectKnowledge('ONE_EFFECT_CONFIRMED', 'SUCCESS'); // 'MULTIPLE_EFFECTS_CONFIRMED'
 * nextEffectKnowledge('UNKNOWN', 'SUCCESS'); // 'UNKNOWN' (BR-RUA-004)
 */
export function nextEffectKnowledge(from: EffectKnowledge, cls: OutcomeClass): EffectKnowledge {
  return EFFECT_KNOWLEDGE_TABLE[from][cls];
}

/**
 * Whether `from -> to` is a cell of the table. The 12 other pairs are refused (AC-RUA-043).
 *
 * @example
 * isPermittedKnowledgeTransition('NOT_ATTEMPTED', 'UNKNOWN'); // true
 * isPermittedKnowledgeTransition('UNKNOWN', 'ONE_EFFECT_CONFIRMED'); // false
 */
export function isPermittedKnowledgeTransition(from: EffectKnowledge, to: EffectKnowledge): boolean {
  return Object.values(EFFECT_KNOWLEDGE_TABLE[from]).includes(to);
}

/**
 * The aggregate knowledge of a request after its attempts, in order, starting from
 * `NOT_ATTEMPTED`.
 *
 * @example
 * foldEffectKnowledge(['AMBIGUOUS', 'SUCCESS']); // 'UNKNOWN' (timeout, then a successful retry)
 * foldEffectKnowledge([]); // 'NOT_ATTEMPTED'
 */
export function foldEffectKnowledge(classes: readonly OutcomeClass[]): EffectKnowledge {
  return classes.reduce<EffectKnowledge>(nextEffectKnowledge, INITIAL_EFFECT_KNOWLEDGE);
}
