// BR-RUA-007 equality (AC-RUA-009): every projection compares its fields across the trials it
// covers; only a manifest-declared difference showing each variant's declared value is declared;
// any other difference fails the projection; a missing input or a coverage gap makes it
// indeterminate. Inherited member names are never values (A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { comparisonReason } from '../../../src/study-comparison/comparison-reasons.ts';
import { evaluateEquality } from '../../../src/study-comparison/equality-evaluation.ts';
import {
  PROJECTION_IDS,
  SLOT_TRIAL_IDS,
  VISIBILITY_DIFFERENCE,
  slotInputs,
  slotRef,
} from './support/equality-inputs.ts';

const DURABLE = new Set([1, 3]);

describe('evaluateEquality', () => {
  it('passes when every projection compares equal values', () => {
    const equality = evaluateEquality(slotInputs(), []);
    assert.equal(equality.equality_result, 'pass');
    assert.deepEqual(equality.reasons, []);
    assert.deepEqual(
      equality.projections.map((projection) => projection.projection_id),
      PROJECTION_IDS,
    );
    for (const projection of equality.projections) {
      assert.equal(projection.result, 'pass');
      assert.deepEqual(projection.compared_fields, ['shared']);
      assert.deepEqual(projection.differences, []);
    }
  });

  it('covers only the CONTROL trials in control_parameters and the treatments in treatment_parameters', () => {
    const equality = evaluateEquality(slotInputs(), []);
    const refsOf = (index: number): readonly string[] =>
      equality.projections[index]?.evidence_refs.map((ref) => ref.artifact_path) ?? [];
    assert.deepEqual(refsOf(1), [slotRef(0).artifact_path, slotRef(1).artifact_path]);
    assert.deepEqual(refsOf(2), [slotRef(2).artifact_path, slotRef(3).artifact_path]);
    assert.equal(refsOf(0).length, 4);
  });

  it('declares a difference the manifest declares when each trial shows its variant value', () => {
    const inputs = slotInputs({
      message_source_protocol: (slot) => ({
        common: { source_visibility_timeout_ms: DURABLE.has(slot) ? 360_000 : 60_000 },
      }),
    });
    const equality = evaluateEquality(inputs, [VISIBILITY_DIFFERENCE]);
    assert.equal(equality.equality_result, 'pass');
    const projection = equality.projections[3];
    assert.equal(projection.result, 'pass');
    assert.deepEqual(projection.differences, [
      {
        field: 'source_visibility_timeout_ms',
        declared: true,
        values: SLOT_TRIAL_IDS.map((id, slot) => ({ trial_id: id, value: DURABLE.has(slot) ? 360_000 : 60_000 })),
      },
    ]);
  });

  it('declares a manifest-declared execution-strategy difference in caller_timing', () => {
    const strategy = { parameter: 'execution_strategy_code', conventional: 'sqs', durable: 'durable', basis: 'D-08' };
    const inputs = slotInputs({
      caller_timing: (slot) => ({ common: { execution_strategy_code: DURABLE.has(slot) ? 'durable' : 'sqs' } }),
    });
    const equality = evaluateEquality(inputs, [strategy]);
    assert.equal(equality.equality_result, 'pass');
    assert.equal(equality.projections[6].result, 'pass');
    assert.equal(equality.projections[6].differences[0]?.declared, true);
  });

  it('never lets a manifest declaration excuse a difference where design §8.14 lists none', () => {
    // BR-RUA-007 excuses only differences "explicitly declared as part of the variants' execution
    // strategies"; §8.14 lists them for message_source_protocol and caller_timing alone.
    const knob = { parameter: 'knob', conventional: 1, durable: 2, basis: 'not an execution strategy' };
    const undeclarable = PROJECTION_IDS.filter((id) => id !== 'message_source_protocol' && id !== 'caller_timing');
    assert.equal(undeclarable.length, 6);
    for (const id of undeclarable) {
      const inputs = slotInputs({ [id]: (slot: number) => ({ common: { knob: DURABLE.has(slot) ? 2 : 1 } }) });
      const equality = evaluateEquality(inputs, [knob]);
      const projection = equality.projections[PROJECTION_IDS.indexOf(id)];
      assert.equal(projection?.result, 'fail', `${id} result`);
      assert.equal(projection.differences[0]?.declared, false, `${id} declared`);
      assert.deepEqual(
        equality.reasons.map(({ code, subject }) => ({ code, subject })),
        [{ code: 'UNDECLARED_DIFFERENCE', subject: `${id}.knob` }],
      );
    }
  });

  it('fails an undeclared difference with UNDECLARED_DIFFERENCE naming projection and field', () => {
    const inputs = slotInputs({
      treatment_parameters: (slot) => ({ common: { treatment_poll_interval_ms: slot === 3 ? 500 : 250 } }),
    });
    const equality = evaluateEquality(inputs, [VISIBILITY_DIFFERENCE]);
    assert.equal(equality.equality_result, 'fail');
    assert.equal(equality.projections[2].result, 'fail');
    assert.deepEqual(
      equality.reasons.map(({ code, subject }) => ({ code, subject })),
      [{ code: 'UNDECLARED_DIFFERENCE', subject: 'treatment_parameters.treatment_poll_interval_ms' }],
    );
    assert.match(
      equality.reasons.map((reason) => reason.detail).join('\n'),
      /has values .*=250, .*=500; expected one value/,
    );
  });

  it('does not declare a declared parameter whose values differ from the declaration', () => {
    const inputs = slotInputs({
      message_source_protocol: (slot) => ({
        common: { source_visibility_timeout_ms: DURABLE.has(slot) ? 900_000 : 60_000 },
      }),
    });
    const equality = evaluateEquality(inputs, [VISIBILITY_DIFFERENCE]);
    assert.equal(equality.projections[3].differences[0]?.declared, false);
    assert.equal(equality.equality_result, 'fail');
  });

  it('does not declare a declared parameter that one trial lacks, and reports it absent', () => {
    const inputs = slotInputs({
      message_source_protocol: (slot) =>
        slot === 0
          ? { common: { shared: 1 } }
          : { common: { source_visibility_timeout_ms: DURABLE.has(slot) ? 360_000 : 60_000 } },
    });
    const difference = evaluateEquality(inputs, [VISIBILITY_DIFFERENCE]).projections[3].differences.find(
      (entry) => entry.field === 'source_visibility_timeout_ms',
    );
    assert.equal(difference?.declared, false);
    assert.equal(difference.values[0]?.value, '<absent>');
  });

  it('reports JSON null as a marker, never as a value', () => {
    const inputs = slotInputs({ observation_window: (slot) => ({ common: { deadline: slot === 2 ? null : 1 } }) });
    const difference = evaluateEquality(inputs, []).projections[7].differences[0];
    assert.deepEqual(
      difference?.values.map((entry) => entry.value),
      [1, 1, '<null>', 1],
    );
  });

  it('compares within-variant fields inside each variant only', () => {
    const acrossVariants = slotInputs({
      caller_timing: (slot) => ({ within_variant: { strategy: DURABLE.has(slot) ? 'durable' : 'sqs' } }),
    });
    assert.equal(evaluateEquality(acrossVariants, []).equality_result, 'pass');
    const insideDurable = slotInputs({
      caller_timing: (slot) => ({ within_variant: { attempts: slot === 3 ? 3 : 2 } }),
    });
    const equality = evaluateEquality(insideDurable, []);
    assert.equal(equality.projections[6].result, 'fail');
    assert.deepEqual(
      equality.projections[6].differences[0]?.values.map((entry) => entry.trial_id),
      [SLOT_TRIAL_IDS[1], SLOT_TRIAL_IDS[3]],
    );
    assert.deepEqual(equality.projections[6].compared_fields, ['shared', 'attempts']);
  });

  it('is indeterminate with the missing input reasons when evidence is absent', () => {
    const reason = comparisonReason('ARTIFACT_MISSING', 'financial_inputs', 'payment absent', 'p');
    const inputs = slotInputs({
      financial_inputs: (slot) => (slot === 1 ? { missing: [reason] } : { common: { shared: 1 } }),
    });
    const equality = evaluateEquality(inputs, []);
    assert.equal(equality.equality_result, 'indeterminate');
    assert.equal(equality.projections[0].result, 'indeterminate');
    assert.deepEqual(equality.reasons, [reason]);
  });

  it('names the projection itself when no covered trial has a sheet', () => {
    const reason = comparisonReason('ARTIFACT_MISSING', 'control_parameters', 'absent');
    const equality = evaluateEquality(slotInputs({ control_parameters: () => ({ missing: [reason] }) }), []);
    assert.deepEqual(equality.projections[1].compared_fields, ['control_parameters']);
    assert.deepEqual(equality.projections[1].evidence_refs, []);
    assert.deepEqual(equality.reasons, [reason, reason]);
  });

  it('is indeterminate when fewer trials than declared cover a projection', () => {
    const equality = evaluateEquality(slotInputs().slice(0, 3), []);
    assert.equal(equality.equality_result, 'indeterminate');
    const gaps = equality.reasons.map(({ code, subject }) => `${code}:${subject}`);
    assert.ok(gaps.includes('EQUALITY_INDETERMINATE:treatment_parameters'));
    assert.ok(gaps.includes('EQUALITY_INDETERMINATE:financial_inputs'));
    assert.ok(!gaps.includes('EQUALITY_INDETERMINATE:control_parameters'));
    assert.match(
      equality.reasons.map((reason) => reason.detail).join('\n'),
      /^3 trial input\(s\) cover financial_inputs; expected the 4 declared trial\(s\)/,
    );
  });

  it('fails rather than stays indeterminate when a difference and a gap coexist', () => {
    const reason = comparisonReason('ARTIFACT_MISSING', 'financial_inputs', 'absent');
    const inputs = slotInputs({
      financial_inputs: (slot) => (slot === 0 ? { missing: [reason] } : { common: { shared: slot } }),
    });
    const equality = evaluateEquality(inputs, []);
    assert.equal(equality.projections[0].result, 'fail');
    assert.equal(equality.equality_result, 'fail');
    assert.equal(equality.reasons.at(-1), reason);
  });

  it('is fail overall when one projection fails and another is indeterminate', () => {
    const reason = comparisonReason('ARTIFACT_MISSING', 'observation_window', 'absent');
    const inputs = slotInputs({
      observation_window: () => ({ missing: [reason] }),
      controller_configuration: (slot) => ({ common: { batch_size: slot === 0 ? 2 : 1 } }),
    });
    assert.equal(evaluateEquality(inputs, []).equality_result, 'fail');
  });

  it('never reads an inherited member as a field value (A-05)', () => {
    const inputs = slotInputs({
      provider_configuration: (slot) => (slot === 2 ? { common: { constructor: 1, toString: 2 } } : { common: {} }),
    });
    const differences = evaluateEquality(inputs, []).projections[4].differences;
    assert.deepEqual(
      differences.map((entry) => entry.field),
      ['constructor', 'toString'],
    );
    assert.deepEqual(
      differences[0]?.values.map((entry) => entry.value),
      ['<absent>', '<absent>', 1, '<absent>'],
    );
  });
});
