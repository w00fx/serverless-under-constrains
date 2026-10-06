// BR-RUA-003 stable logical identity (AC-RUA-039): every attempt carries the approved
// refund_request_id.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateValue } from '../../../src/record-contract/primitives.ts';
import type { RuleResult } from '../../../src/record-contract/records/group-c/oracle_result.ts';
import { readAttempts } from '../../../src/trial-oracle/attempt-facts.ts';
import { evaluateLogicalIdentity } from '../../../src/trial-oracle/logical-identity-rule.ts';
import { businessInputs } from '../../../src/trial-oracle/oracle-inputs.ts';
import { builtEvidence } from './support/built-trials.ts';
import type { TrialBuild } from './support/built-trials.ts';
import { CALLER_JOURNAL, withoutAttempts } from './support/trial-edits.ts';
import { CONVENTIONAL_CONTROL, CONVENTIONAL_TREATMENT, edited } from './support/trial-plans.ts';

function evaluate(build: TrialBuild, identityIntegrity: GateValue = 'verified'): RuleResult {
  const evidence = builtEvidence(build);
  return evaluateLogicalIdentity(evidence, readAttempts(evidence), businessInputs(evidence), identityIntegrity);
}

const codes = (rule: ReturnType<typeof evaluate>): readonly string[] =>
  rule.indeterminate_reasons.map((reason) => reason.code);

describe('evaluateLogicalIdentity', () => {
  it('passes when every attempt carries the approved id, citing the attempts and the decision', () => {
    const rule = evaluate(CONVENTIONAL_TREATMENT);
    assert.equal(rule.rule_id, 'BR-RUA-003');
    assert.equal(rule.result, 'pass');
    assert.deepEqual(rule.expected, { refund_request_ids: ['ref-poc-001'] });
    assert.deepEqual(rule.observed, { refund_request_ids: ['ref-poc-001'] });
    assert.equal(rule.evidence_refs.length, 3);
  });

  it('fails when a retry carries another id (AC-RUA-039)', () => {
    const rule = evaluate({
      base: 'run-conventional-treatment',
      plan: {
        deliveries: [
          { attempts: [{ behavior: 'targeted_timeout' }] },
          { attempts: [{ behavior: 'succeeded', refund_request_id: 'ref-poc-002' }] },
        ],
        processing: 'completes',
      },
    });
    assert.equal(rule.result, 'fail');
    assert.deepEqual(rule.observed, { refund_request_ids: ['ref-poc-001', 'ref-poc-002'] });
  });

  it('fails on another id even when identity integrity is unverified', () => {
    const build: TrialBuild = {
      base: 'run-conventional-control',
      plan: {
        deliveries: [{ attempts: [{ behavior: 'succeeded', refund_request_id: 'ref-poc-999' }] }],
        processing: 'completes',
      },
    };
    assert.equal(evaluate(build, 'unverified').result, 'fail');
  });

  it('is not applicable without any attempt in a complete caller journal', () => {
    const rule = evaluate(edited(CONVENTIONAL_CONTROL, withoutAttempts()));
    assert.equal(rule.result, 'not_applicable');
    assert.deepEqual(rule.observed, { code: 'NO_ATTEMPTS', refund_request_ids: [] });
  });

  it('is indeterminate with ARTIFACT_MISSING when the caller journal is absent, citing the decision', () => {
    const rule = evaluate(edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: CALLER_JOURNAL }]));
    assert.equal(rule.result, 'indeterminate');
    assert.deepEqual(codes(rule), ['ARTIFACT_MISSING']);
    assert.equal(rule.evidence_refs.length, 1);
  });

  it('is indeterminate with ARTIFACT_INCOMPLETE when the caller journal is gapped, citing it', () => {
    const rule = evaluate(
      edited(CONVENTIONAL_CONTROL, [
        { op: 'remove_record', path: CALLER_JOURNAL, select: { record_type: 'dispatch_started' } },
      ]),
    );
    assert.equal(rule.result, 'indeterminate');
    assert.deepEqual(codes(rule), ['ARTIFACT_INCOMPLETE']);
    assert.ok(
      rule.evidence_refs.some(
        (ref) => ref.artifact_path.endsWith('/journals/caller-journal.jsonl') && ref.event_id === undefined,
      ),
    );
  });

  it('is indeterminate with INPUT_MISSING without the approved decision', () => {
    const rule = evaluate(
      edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: '$trial/inputs/approved-decision.json' }]),
    );
    assert.equal(rule.result, 'indeterminate');
    assert.deepEqual(codes(rule), ['INPUT_MISSING']);
    assert.deepEqual(rule.expected, { refund_request_ids: [null] });
  });

  it('is indeterminate when identity integrity is unverified and every seen attempt agrees', () => {
    const rule = evaluate(CONVENTIONAL_CONTROL, 'unverified');
    assert.equal(rule.result, 'indeterminate');
    assert.deepEqual(codes(rule), ['IDENTITY_EVIDENCE_UNVERIFIED']);
  });

  it('passes when identity integrity is invalid: the invalid gate already decides the trial', () => {
    assert.equal(evaluate(CONVENTIONAL_CONTROL, 'invalid').result, 'pass');
  });
});
