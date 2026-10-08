// Treatment fidelity over hostile bytes (Owner amendment A-05): nesting deeper than any call stack,
// a number beyond binary64, and member names a prototype lookup would find. Every path rejects or
// downgrades; none throws, and every condition still follows BR-RUA-035.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IngestedEvidence } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { deriveControlIntegrity } from '../../../src/treatment-fidelity/control-integrity.ts';
import { evaluateTreatmentConditions } from '../../../src/treatment-fidelity/treatment-conditions.ts';
import { deriveTreatmentFidelity } from '../../../src/treatment-fidelity/treatment-fidelity.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';
import { hostileProbeEvidence, SUBJECT_FILES, treatmentView } from './support/treatment-evidence.ts';
import { assertWellFormedCondition } from './support/view-edits.ts';

/** Replaces the line holding `recordType` with `line`. */
function replacingLine(recordType: string, line: string): (text: string) => string {
  return (text) =>
    text
      .split('\n')
      .map((candidate) => (candidate.includes(`"record_type":"${recordType}"`) ? line : candidate))
      .join('\n');
}

function judgedTotally(evidence: IngestedEvidence): ReturnType<typeof evaluateTreatmentConditions> {
  const view = treatmentView(evidence);
  const conditions = evaluateTreatmentConditions(view);
  conditions.forEach(assertWellFormedCondition);
  deriveTreatmentFidelity(conditions, view);
  assert.equal(deriveControlIntegrity(evidence).value, 'not_applicable');
  return conditions;
}

describe('treatment fidelity over hostile bytes (A-05)', () => {
  it(`judges a caller timeout replaced by ${String(DEEP_NESTING)} levels of nesting as missing`, () => {
    for (const shape of ['array', 'object', 'mixed'] as const) {
      const tower = towerText(shape, DEEP_NESTING, '1');
      const conditions = judgedTotally(
        hostileProbeEvidence(SUBJECT_FILES.caller, replacingLine('caller_timeout_recorded', tower)),
      );
      assert.notEqual(conditions[0].result, 'pass', shape);
      assert.notEqual(conditions[1].result, 'pass', shape);
    }
  });

  it('reads a treatment snapshot of deep nesting as no snapshot', () => {
    const evidence = hostileProbeEvidence(SUBJECT_FILES.snapshot, () => towerText('object', DEEP_NESTING, 'null'));
    const view = treatmentView(evidence);
    assert.equal(view.snapshot, undefined);
    assert.equal(deriveTreatmentFidelity(evaluateTreatmentConditions(view), view).treatment_fidelity, 'unverified');
  });

  it('never orders by a sequence number beyond binary64 (1e400)', () => {
    const evidence = hostileProbeEvidence(SUBJECT_FILES.provider, (text) =>
      text.replace('"source_sequence":6', '"source_sequence":1e400'),
    );
    const conditions = judgedTotally(evidence);
    assert.notEqual(conditions[4].result, 'pass');
  });

  it('never counts a ledger amount beyond binary64 (1e400) as a usable transaction', () => {
    const evidence = hostileProbeEvidence(SUBJECT_FILES.ledger, (text) =>
      text.replace('"amount_minor":10000', '"amount_minor":1e400'),
    );
    const view = treatmentView(evidence);
    assert.notEqual(view.ledger.status, 'present');
    judgedTotally(evidence);
  });

  it('never reads inherited names (__proto__, constructor) as record members', () => {
    const lines = [
      '{"__proto__":{"record_type":"caller_timeout_recorded"},"constructor":1,"toString":2}',
      '{"record_type":"__proto__"}',
      '{"record_type":"constructor","attempt_id":"constructor"}',
    ];
    const evidence = hostileProbeEvidence(
      SUBJECT_FILES.caller,
      replacingLine('caller_timeout_recorded', lines.join('\n')),
    );
    const view = treatmentView(evidence);
    assert.equal(view.caller_timeout, undefined);
    const conditions = judgedTotally(evidence);
    assert.notEqual(conditions[1].result, 'pass');
  });

  it('never binds a treatment item whose members are inherited names', () => {
    const evidence = hostileProbeEvidence(SUBJECT_FILES.snapshot, (text) =>
      text.replace('"item_present":true', '"item_present":true,"__proto__":{"consistent_read":true}'),
    );
    const view = treatmentView(evidence);
    assert.equal(view.snapshot, undefined);
    judgedTotally(evidence);
  });
});
