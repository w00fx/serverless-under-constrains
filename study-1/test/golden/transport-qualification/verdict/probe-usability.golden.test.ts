// AC-RUA-056 golden (design §14): a probe whose transport conditions all pass cannot be selected
// when any usability condition is unmet. Each case is the passing probe of
// `ac021-probe-verdict-pass` in a package that changes one spec-named fact; the expected reason is
// the BR-RUA-026 row that fact breaks (design §8.11).
//
// A package that is not verified also has no established effective closure: CTR-RUA-004 derives
// the effective cleanup, audit and lease values only for an eligible package, so that case names
// OPERATIONAL_CLOSURE_NOT_CLEAN beside PACKAGE_NOT_VERIFIED.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { ProbeUnusabilityCode } from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import { assessProbeUsability } from '../../../../src/transport-qualification/verdict/probe-usability.ts';
import { readProbeUsabilityInput } from '../../../../src/transport-qualification/verdict/probe-usability-reader.ts';
import { GOLDEN_VALIDATOR, loadProbeCase } from './support/probe-golden.ts';
import { packageInput, probePackage } from './support/probe-package.ts';
import type { ProbePackageVariation } from './support/probe-package.ts';

async function reasonCodesOf(variation: ProbePackageVariation): Promise<readonly string[]> {
  const loaded = await loadProbeCase('ac021-probe-verdict-pass');
  const deps = { validator: GOLDEN_VALIDATOR, digest: sha256Hex };
  const assessment = assessProbeUsability(
    readProbeUsabilityInput(packageInput(probePackage(loaded.files, variation)), deps),
  );
  assert.equal(
    GOLDEN_VALIDATOR.validateAs('probe_usability_assessment', assessment as unknown as JsonValue).valid,
    true,
  );
  assert.equal(assessment.transport_probe_verdict, 'pass');
  assert.equal(assessment.probe_usability, 'not_usable');
  return assessment.reasons.map((reason) => reason.code);
}

function codes(...expected: readonly ProbeUnusabilityCode[]): readonly string[] {
  return expected;
}

describe('AC-RUA-056 a passing probe that is not usable cannot be selected', () => {
  it('unclean-operational-closure', async () => {
    const variation = { summary: { cleanup_status: 'failed', probe_terminal_reason: 'CLEANUP_INCOMPLETE' } } as const;
    assert.deepEqual(await reasonCodesOf(variation), codes('OPERATIONAL_CLOSURE_NOT_CLEAN'));
  });

  it('package-not-verified', async () => {
    const variation = { altered_after_index: EXECUTION_PATHS.resourceManifest };
    assert.deepEqual(await reasonCodesOf(variation), codes('OPERATIONAL_CLOSURE_NOT_CLEAN', 'PACKAGE_NOT_VERIFIED'));
  });

  it('contradictory-late-evidence', async () => {
    assert.deepEqual(
      await reasonCodesOf({ late_evidence_status: 'contradictory' }),
      codes('LATE_EVIDENCE_CONTRADICTORY'),
    );
  });

  it('no-transport-scope-snapshot', async () => {
    assert.deepEqual(await reasonCodesOf({ without_scope_snapshot: true }), codes('NO_TRANSPORT_SCOPE_SNAPSHOT'));
  });

  it('known-safety-breach', async () => {
    assert.deepEqual(await reasonCodesOf({ summary: { safety_status: 'breached' } }), codes('KNOWN_SAFETY_BREACH'));
  });
});
