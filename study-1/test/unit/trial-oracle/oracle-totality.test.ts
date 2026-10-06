// The trial oracle over hostile bytes (Owner amendment A-05), end to end from ingestion: nesting
// deeper than any call stack, numbers beyond binary64 and member names a prototype lookup would
// find, in the journals, the ledger and the business inputs. The oracle never throws and never
// refuses a trial it can name: it returns a result that holds its schemas and BR-RUA-035, and the
// rules that read the hostile bytes are indeterminate instead of judging them.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ingestEvidence } from '../../../src/evidence-ingestion/ingest-evidence.ts';
import type { RuleResult } from '../../../src/record-contract/records/group-c/oracle_result.ts';
import { evaluateTrial } from '../../../src/trial-oracle/evaluate-trial.ts';
import type { TrialEvaluation } from '../../../src/trial-oracle/evaluate-trial.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';
import { subjectDirectoryOf } from '../../support/golden-builder/scenario-builder.ts';
import { ORACLE_VALIDATOR, trialIngestionInput } from './support/built-trials.ts';
import type { TrialBuild } from './support/built-trials.ts';
import { evaluationContractProblems, UNIT_CHECKED_AT } from './support/evaluated-trials.ts';
import { CONVENTIONAL_CONTROL, CONVENTIONAL_TREATMENT } from './support/trial-plans.ts';

const CALLER = 'journals/caller-journal.jsonl';
const LEDGER = 'ledger/ledger-snapshot.json';
const PAYMENT = 'inputs/payment.json';
const DECISION = 'inputs/approved-decision.json';

/**
 * Evaluates a build after rewriting the text of one of its subject trial's files (a path below
 * the trial directory). Never cached: the bytes are the test's own.
 */
function hostileEvaluation(build: TrialBuild, file: string, rewrite: (text: string) => string): TrialEvaluation {
  const input = trialIngestionInput(build);
  const target = `${subjectDirectoryOf(build.base)}/${file}`;
  if (!input.artifacts.some((artifact) => artifact.path === target)) {
    throw new Error(`${target} is not an artifact of ${build.base}; expected a subject trial file`);
  }
  const artifacts = input.artifacts.map((artifact) =>
    artifact.path === target
      ? { path: artifact.path, bytes: new TextEncoder().encode(rewrite(new TextDecoder().decode(artifact.bytes))) }
      : artifact,
  );
  const evaluated = evaluateTrial({
    evidence: ingestEvidence({ ...input, artifacts }, ORACLE_VALIDATOR),
    checked_at: UNIT_CHECKED_AT,
  });
  if (!evaluated.ok) {
    throw new Error(`${target} rewritten was refused: ${JSON.stringify(evaluated.error)}; expected a result`);
  }
  return evaluated.value;
}

/** Replaces each line holding `recordType` with `line`. */
function replacingLine(recordType: string, line: string): (text: string) => string {
  return (text) =>
    text
      .split('\n')
      .map((candidate) => (candidate.includes(`"record_type":"${recordType}"`) ? line : candidate))
      .join('\n');
}

/** Replaces `from`, which must occur in the text, with `to`. */
function replacingText(from: string, to: string): (text: string) => string {
  return (text) => {
    if (!text.includes(from)) {
      throw new Error(`the fixture text has no ${from}; expected it to rewrite`);
    }
    return text.replace(from, to);
  };
}

function rule(evaluation: TrialEvaluation, ruleId: string): RuleResult {
  const found = evaluation.result.rule_results.find((candidate) => candidate.rule_id === ruleId);
  if (found === undefined) {
    throw new Error(`the result has no ${ruleId}; expected all ten rules`);
  }
  return found;
}

/**
 * The evaluation holds its contracts and does not pass, and each of `ruleIds`, whose evidence the
 * hostile bytes made unreadable, is indeterminate rather than judged on them.
 */
function assertJudgedTotally(evaluation: TrialEvaluation, ruleIds: readonly string[], label: string): void {
  assert.deepEqual(evaluationContractProblems(evaluation), [], label);
  assert.notEqual(evaluation.result.preservation_verdict, 'pass', label);
  for (const ruleId of ruleIds) {
    assert.equal(rule(evaluation, ruleId).result, 'indeterminate', `${label}: ${ruleId}`);
  }
}

describe('evaluateTrial over hostile bytes (A-05)', () => {
  it(`judges a caller attempt replaced by ${String(DEEP_NESTING)} levels of nesting as unknown`, () => {
    for (const shape of ['array', 'object', 'mixed'] as const) {
      const tower = towerText(shape, DEEP_NESTING, '1');
      const evaluation = hostileEvaluation(CONVENTIONAL_TREATMENT, CALLER, replacingLine('attempt_registered', tower));
      assertJudgedTotally(evaluation, ['BR-RUA-004'], shape);
    }
  });

  it(`reads a ledger snapshot of ${String(DEEP_NESTING)} levels of nesting as no ledger`, () => {
    const evaluation = hostileEvaluation(CONVENTIONAL_CONTROL, LEDGER, () => towerText('object', DEEP_NESTING, 'null'));
    assertJudgedTotally(evaluation, ['BR-RUA-001', 'BR-RUA-002'], 'ledger');
  });

  it('never counts a ledger amount beyond binary64 (1e400)', () => {
    const evaluation = hostileEvaluation(
      CONVENTIONAL_CONTROL,
      LEDGER,
      replacingText('"amount_minor":10000', '"amount_minor":1e400'),
    );
    assertJudgedTotally(evaluation, ['BR-RUA-001', 'BR-RUA-002'], 'ledger amount');
  });

  it('never caps refunds by a captured or approved amount beyond binary64 (1e400)', () => {
    const payment = hostileEvaluation(
      CONVENTIONAL_CONTROL,
      PAYMENT,
      replacingText('"captured_amount_minor":10000', '"captured_amount_minor":1e400'),
    );
    assertJudgedTotally(payment, ['BR-RUA-002'], 'payment');
    const decision = hostileEvaluation(
      CONVENTIONAL_CONTROL,
      DECISION,
      replacingText('"approved_amount_minor":10000', '"approved_amount_minor":1e400'),
    );
    assertJudgedTotally(decision, ['BR-RUA-001'], 'decision');
  });

  it('never orders request states by a version beyond binary64 (1e400)', () => {
    const evaluation = hostileEvaluation(
      CONVENTIONAL_TREATMENT,
      CALLER,
      replacingText('"version":2', '"version":1e400'),
    );
    assertJudgedTotally(evaluation, ['BR-RUA-004'], 'version');
  });

  it('never reads inherited names (__proto__, constructor, toString) as journal records', () => {
    const lines = [
      '{"__proto__":{"record_type":"attempt_outcome_recorded"},"constructor":1,"toString":2}',
      '{"record_type":"__proto__"}',
      '{"record_type":"constructor","attempt_id":"constructor"}',
      '{"record_type":"toString","outcome":"toString"}',
    ];
    const evaluation = hostileEvaluation(
      CONVENTIONAL_TREATMENT,
      CALLER,
      replacingLine('attempt_outcome_recorded', lines.join('\n')),
    );
    assertJudgedTotally(evaluation, ['BR-RUA-004'], 'caller');
  });

  it('never reads a business input whose members are inherited names', () => {
    const payment = hostileEvaluation(CONVENTIONAL_CONTROL, PAYMENT, (text) => `{"__proto__":${text.trim()}}`);
    assertJudgedTotally(payment, ['BR-RUA-002'], 'payment');
    const decision = hostileEvaluation(
      CONVENTIONAL_CONTROL,
      DECISION,
      replacingText('"decision":"APPROVED"', '"decision":"APPROVED","constructor":{"approved_amount_minor":1}'),
    );
    assertJudgedTotally(decision, ['BR-RUA-001'], 'decision');
  });
});
