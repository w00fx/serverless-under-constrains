// AC-RUA-002 and AC-RUA-021 goldens (design §14): the six conditions and the probe verdict derived
// from the base probe's frozen evidence, and the usability of that passing probe. The verdict cases
// state their expectations in their case files, from the spec; the usability case states it here:
// a passing, valid, faithful probe with verified evidence, no late evidence, a clean closure, no
// safety breach, an eligible package and an indexed scope snapshot is usable (BR-RUA-026).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { assessProbeUsability } from '../../../../src/transport-qualification/verdict/probe-usability.ts';
import { readProbeUsabilityInput } from '../../../../src/transport-qualification/verdict/probe-usability-reader.ts';
import { GOLDEN_VALIDATOR, loadProbeCase } from './support/probe-golden.ts';
import { packageInput, probePackage } from './support/probe-package.ts';
import { assertVerdictCase } from './support/verdict-assertions.ts';

describe('AC-RUA-002 and AC-RUA-021 a clean probe passes and is usable', () => {
  it('ac002-condition-derivation', async () => {
    await assertVerdictCase('ac002-condition-derivation');
  });

  it('ac021-probe-verdict-pass', async () => {
    await assertVerdictCase('ac021-probe-verdict-pass');
  });

  it('ac021-usable-probe-selectable', async () => {
    const loaded = await loadProbeCase('ac021-probe-verdict-pass');
    const deps = { validator: GOLDEN_VALIDATOR, digest: sha256Hex };
    const assessment = assessProbeUsability(readProbeUsabilityInput(packageInput(probePackage(loaded.files)), deps));
    assert.equal(assessment.probe_usability, 'usable');
    assert.deepEqual(assessment.reasons, []);
    assert.equal(
      GOLDEN_VALIDATOR.validateAs('probe_usability_assessment', assessment as unknown as JsonValue).valid,
      true,
    );
  });
});
