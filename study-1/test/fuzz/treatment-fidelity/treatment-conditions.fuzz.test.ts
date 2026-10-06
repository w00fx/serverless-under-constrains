// Design §12.5 and §8.10 as properties: over arbitrary edits of the probe's journals and treatment
// snapshot, the treatment view, the six conditions, fidelity and control integrity never throw
// (A-05); the conditions keep their order and BR-RUA-035 references; affected evidence never yields
// a conclusive result; and fidelity agrees with the conditions (BR-RUA-025).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { deriveControlIntegrity } from '../../../src/treatment-fidelity/control-integrity.ts';
import { evaluateTreatmentConditions } from '../../../src/treatment-fidelity/treatment-conditions.ts';
import { deriveTreatmentFidelity } from '../../../src/treatment-fidelity/treatment-fidelity.ts';
import { buildTreatmentView } from '../../../src/treatment-fidelity/treatment-view.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { assertWellFormedCondition } from '../../unit/treatment-fidelity/support/view-edits.ts';
import { editedProbeEvidence, journalEditsArbitrary } from './support/journal-edits.ts';

const CONDITION_ORDER = ['BR-RUA-010', 'BR-RUA-011', 'BR-RUA-012', 'BR-RUA-013', 'BR-RUA-014', 'BR-RUA-015'];

describe('treatment conditions over arbitrary probe edits', () => {
  it('are total, ordered, referenced and never conclusive on affected evidence', () => {
    fc.assert(
      fc.property(journalEditsArbitrary, (edits) => {
        const evidence = editedProbeEvidence(edits);
        const view = buildTreatmentView(evidence);
        assert.equal(view.ok, true, 'the probe always has a treatment view');
        const conditions = evaluateTreatmentConditions(view.value);
        assert.deepEqual(
          conditions.map((condition) => condition.condition_id),
          CONDITION_ORDER,
        );
        for (const condition of conditions) {
          assertWellFormedCondition(condition);
          assert.deepEqual(condition.affected_by, [...new Set(condition.affected_by)].toSorted());
          assert.ok(condition.affected_by.length === 0 || condition.result === 'indeterminate', condition.condition_id);
        }
        assert.equal(deriveControlIntegrity(evidence).value, 'not_applicable');
      }),
      fuzzParameters(),
    );
  });

  it('keep fidelity consistent with the conditions', () => {
    fc.assert(
      fc.property(journalEditsArbitrary, (edits) => {
        const view = buildTreatmentView(editedProbeEvidence(edits));
        assert.equal(view.ok, true, 'the probe always has a treatment view');
        const conditions = evaluateTreatmentConditions(view.value);
        const fidelity = deriveTreatmentFidelity(conditions, view.value);
        const unaffectedFail = conditions.some(
          (condition) => condition.result === 'fail' && condition.affected_by.length === 0,
        );
        if (unaffectedFail) {
          assert.equal(fidelity.treatment_fidelity, 'invalid');
        }
        if (fidelity.treatment_fidelity === 'verified') {
          assert.ok(conditions.every((condition) => condition.result === 'pass'));
        }
        assert.equal(fidelity.reasons.length === 0, fidelity.treatment_fidelity === 'verified');
        assert.equal(fidelity.fidelity_basis, 'causal_plus_cross_source_clock_assumption');
        assert.deepEqual(fidelity.clock_assumption_refs, ['CA-1']);
      }),
      fuzzParameters(),
    );
  });
});
