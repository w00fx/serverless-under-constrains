// BR-RUA-004 unknown outcome (D-03): after an ambiguous attempt, every request state that names an
// ambiguous attempt records UNKNOWN.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RuleResult } from '../../../src/record-contract/records/group-c/oracle_result.ts';
import { readAttempts } from '../../../src/trial-oracle/attempt-facts.ts';
import { evaluateUnknownOutcome } from '../../../src/trial-oracle/unknown-outcome-rule.ts';
import { builtEvidence } from './support/built-trials.ts';
import type { TrialBuild } from './support/built-trials.ts';
import { CALLER_JOURNAL, notDispatched, withoutOutcome } from './support/trial-edits.ts';
import { CONVENTIONAL_CONTROL, CONVENTIONAL_TREATMENT, DURABLE_TREATMENT, edited } from './support/trial-plans.ts';

const SECOND_STATE = { record_type: 'request_state_recorded', occurrence: 2 } as const;

function evaluate(build: TrialBuild): RuleResult {
  const evidence = builtEvidence(build);
  return evaluateUnknownOutcome(evidence, readAttempts(evidence));
}

const codes = (rule: ReturnType<typeof evaluate>): readonly string[] =>
  rule.indeterminate_reasons.map((reason) => reason.code);

describe('evaluateUnknownOutcome', () => {
  it('passes when every state after the timeout records UNKNOWN, per variant', () => {
    for (const build of [CONVENTIONAL_TREATMENT, DURABLE_TREATMENT]) {
      const rule = evaluate(build);
      assert.equal(rule.rule_id, 'BR-RUA-004');
      assert.equal(rule.result, 'pass', build.base);
      assert.deepEqual(rule.observed, {
        recorded: [
          { version: 1, effect_knowledge: 'UNKNOWN' },
          { version: 2, effect_knowledge: 'UNKNOWN' },
        ],
      });
      assert.equal(rule.evidence_refs.length, 3);
    }
  });

  it('is not applicable without an ambiguous attempt', () => {
    const rule = evaluate(CONVENTIONAL_CONTROL);
    assert.equal(rule.result, 'not_applicable');
    assert.deepEqual(rule.observed, { code: 'NO_AMBIGUOUS_OUTCOME', recorded: [] });
    assert.deepEqual(rule.expected, { first_ambiguous_attempt_id: null, effect_knowledge: 'UNKNOWN' });
  });

  it('fails when a state after the ambiguous outcome claims a confirmed effect', () => {
    const rule = evaluate(
      edited(CONVENTIONAL_TREATMENT, [
        {
          op: 'set',
          path: CALLER_JOURNAL,
          select: SECOND_STATE,
          pointer: '/effect_knowledge',
          value: 'ONE_EFFECT_CONFIRMED',
        },
      ]),
    );
    assert.equal(rule.result, 'fail');
  });

  it('is indeterminate with ARTIFACT_MISSING when the caller journal is absent', () => {
    const rule = evaluate(edited(CONVENTIONAL_TREATMENT, [{ op: 'delete_file', path: CALLER_JOURNAL }]));
    assert.equal(rule.result, 'indeterminate');
    assert.deepEqual(codes(rule), ['ARTIFACT_MISSING']);
    assert.deepEqual(rule.evidence_refs, []);
  });

  it('is indeterminate with ARTIFACT_INCOMPLETE when the caller journal is gapped, citing it', () => {
    const rule = evaluate(
      edited(CONVENTIONAL_TREATMENT, [
        { op: 'remove_record', path: CALLER_JOURNAL, select: { record_type: 'dispatch_started' } },
      ]),
    );
    assert.equal(rule.result, 'indeterminate');
    assert.deepEqual(codes(rule), ['ARTIFACT_INCOMPLETE']);
    assert.ok(rule.evidence_refs.some((ref) => ref.event_id === undefined));
  });

  it('is indeterminate when an ambiguous attempt has no outcome', () => {
    const rule = evaluate(edited(CONVENTIONAL_TREATMENT, withoutOutcome(1)));
    assert.equal(rule.result, 'indeterminate');
    assert.deepEqual(codes(rule), ['OUTCOME_MISSING']);
    assert.match(rule.indeterminate_reasons[0]?.detail ?? '', /dispatch state DISPATCHED and no recorded outcome/);
  });

  it('is indeterminate when an outcome contradicts its dispatch evidence', () => {
    const rule = evaluate(edited(CONVENTIONAL_TREATMENT, notDispatched(1)));
    assert.equal(rule.result, 'indeterminate');
    assert.equal(rule.indeterminate_reasons[0]?.subject, 'BR-RUA-004');
    assert.equal(codes(rule).length, 1);
  });

  it('is indeterminate when the request-state versions are not dense', () => {
    const rule = evaluate(
      edited(CONVENTIONAL_TREATMENT, [
        { op: 'set', path: CALLER_JOURNAL, select: SECOND_STATE, pointer: '/version', value: 3 },
      ]),
    );
    assert.equal(rule.result, 'indeterminate');
    assert.deepEqual(codes(rule), ['REQUEST_STATE_VERSIONS_NOT_DENSE']);
    assert.match(rule.indeterminate_reasons[0]?.detail ?? '', /request-state versions are 1, 3; expected 1\.\.2/);
  });

  it('is indeterminate when no request state names an ambiguous attempt', () => {
    const rule = evaluate(
      edited(CONVENTIONAL_TREATMENT, [
        { op: 'remove_record', path: CALLER_JOURNAL, select: { record_type: 'request_state_recorded' } },
        { op: 'remove_record', path: CALLER_JOURNAL, select: { record_type: 'request_state_recorded' } },
        { op: 'resequence', path: CALLER_JOURNAL },
      ]),
    );
    assert.equal(rule.result, 'indeterminate');
    assert.deepEqual(codes(rule), ['REQUEST_STATE_NOT_RECORDED']);
  });
});
