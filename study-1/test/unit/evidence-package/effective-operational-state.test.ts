// The effective operational state (CTR-RUA-004; BR-RUA-038): the original closure, replaced only by
// OPERATIONAL_RECOVERY amendments of a verified selected chain in chain order; everything is
// `unverified` when the package is ineligible, the original cleanup is non-terminal, or a selected
// recovery cannot be found or read.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { effectiveOperationalState } from '../../../src/evidence-package/effective-operational-state.ts';
import type { OriginalClosure } from '../../../src/evidence-package/effective-operational-state.ts';
import { verifyPackage } from '../../../src/evidence-package/package-verifier.ts';
import type { OperationalClosure } from '../../../src/record-contract/records/group-c/operational_recovery_record.ts';
import type { PackageVerification } from '../../../src/record-contract/records/group-c/package_verification.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { utf8 } from '../../support/evidence-package/package-files.ts';
import {
  FIXTURE_DEPS,
  amendmentChain,
  billingPayload,
  probePackage,
  recoveryPayload,
  replaceFile,
  verificationInput,
} from '../../support/evidence-package/probe-package-fixtures.ts';
import type { FixtureAmendment, ProbePackage } from '../../support/evidence-package/probe-package-fixtures.ts';

const PARTIAL: OperationalClosure = {
  cleanup_status: 'partial',
  leak_audit_status: 'leaks_detected',
  lease_status: 'recovery_required',
};
const CLEAN: OperationalClosure = { cleanup_status: 'succeeded', leak_audit_status: 'clean', lease_status: 'released' };
const UNVERIFIED = {
  effective_cleanup_status: 'unverified',
  effective_leak_audit_status: 'unverified',
  effective_lease_status: 'unverified',
  operational_recovery_applied: false,
};

function verified(fixture: ProbePackage, chain: readonly FixtureAmendment[]): PackageVerification {
  return verifyPackage(verificationInput(fixture, chain, chain.at(-1)?.index_sha256 ?? null), FIXTURE_DEPS);
}

function stateOf(
  fixture: ProbePackage,
  chain: readonly FixtureAmendment[],
  original: OriginalClosure,
  verification = verified(fixture, chain),
): ReturnType<typeof effectiveOperationalState> {
  return effectiveOperationalState(
    { verification, original_closure: original, amendments: chain.map((amendment) => amendment.snapshot) },
    FIXTURE_DEPS,
  );
}

describe('effectiveOperationalState', () => {
  it('keeps the original closure when no recovery is selected', () => {
    const fixture = probePackage();
    const chain = amendmentChain(fixture, [{ kind: 'BILLING', payload: [billingPayload()] }]);
    assert.deepEqual(stateOf(fixture, chain, PARTIAL), {
      effective_cleanup_status: 'partial',
      effective_leak_audit_status: 'leaks_detected',
      effective_lease_status: 'recovery_required',
      operational_recovery_applied: false,
    });
  });

  it('applies recoveries in chain order and records that one changed a value', () => {
    const fixture = probePackage();
    const chain = amendmentChain(fixture, [
      { kind: 'OPERATIONAL_RECOVERY', payload: [recoveryPayload(fixture, PARTIAL, PARTIAL)] },
      { kind: 'OPERATIONAL_RECOVERY', payload: [recoveryPayload(fixture, PARTIAL, CLEAN)] },
    ]);
    assert.equal(verified(fixture, chain).package_eligibility, 'eligible');
    assert.deepEqual(stateOf(fixture, chain, PARTIAL), {
      effective_cleanup_status: 'succeeded',
      effective_leak_audit_status: 'clean',
      effective_lease_status: 'released',
      operational_recovery_applied: true,
    });
  });

  it('records no applied recovery when the recovery changed nothing', () => {
    const fixture = probePackage();
    const chain = amendmentChain(fixture, [
      { kind: 'OPERATIONAL_RECOVERY', payload: [recoveryPayload(fixture, CLEAN, CLEAN)] },
    ]);
    assert.equal(stateOf(fixture, chain, CLEAN).operational_recovery_applied, false);
  });

  it('is unverified for an ineligible package or a non-terminal original cleanup', () => {
    const fixture = probePackage();
    const chain = amendmentChain(fixture, [
      { kind: 'OPERATIONAL_RECOVERY', payload: [recoveryPayload(fixture, PARTIAL, CLEAN)] },
    ]);
    const ineligible = verifyPackage(verificationInput(fixture, chain, null), FIXTURE_DEPS);
    assert.equal(ineligible.package_eligibility, 'ineligible');
    assert.deepEqual(stateOf(fixture, chain, PARTIAL, ineligible), UNVERIFIED);
    assert.deepEqual(stateOf(fixture, [], { ...CLEAN, cleanup_status: 'running' }), UNVERIFIED);
    assert.deepEqual(stateOf(fixture, [], { ...CLEAN, cleanup_status: 'not_started' }), UNVERIFIED);
  });

  it('is unverified when a selected recovery is missing, unreadable or for another package', () => {
    const fixture = probePackage();
    const chain = amendmentChain(fixture, [
      { kind: 'OPERATIONAL_RECOVERY', payload: [recoveryPayload(fixture, PARTIAL, CLEAN)] },
    ]);
    const verification = verified(fixture, chain);
    const missing = effectiveOperationalState(
      { verification, original_closure: PARTIAL, amendments: [] },
      FIXTURE_DEPS,
    );
    assert.deepEqual(missing, UNVERIFIED);
    const [only] = chain;
    assert.ok(only !== undefined);
    const withPayload = (bytes: Uint8Array): ReturnType<typeof effectiveOperationalState> =>
      effectiveOperationalState(
        {
          verification,
          original_closure: PARTIAL,
          amendments: [
            {
              ...only.snapshot,
              files: replaceFile(only.snapshot.files, 'payload/operational-recovery-record.json', bytes),
            },
          ],
        },
        FIXTURE_DEPS,
      );
    assert.deepEqual(withPayload(utf8('{}')), UNVERIFIED);
    const foreign = recoveryPayload({ ...fixture, index_sha256: sha256Hex(utf8('other')) }, PARTIAL, CLEAN);
    assert.deepEqual(withPayload(foreign.bytes), UNVERIFIED);
    const noIndex = effectiveOperationalState(
      {
        verification,
        original_closure: PARTIAL,
        amendments: [
          { ...only.snapshot, files: only.snapshot.files.filter((file) => file.path !== 'amendment-index.json') },
        ],
      },
      FIXTURE_DEPS,
    );
    assert.deepEqual(noIndex, UNVERIFIED);
  });

  it('is unverified when the selected recovery amendment holds no recovery record', () => {
    const fixture = probePackage();
    const chain = amendmentChain(fixture, [
      { kind: 'OPERATIONAL_RECOVERY', payload: [recoveryPayload(fixture, PARTIAL, CLEAN)] },
    ]);
    const [only] = chain;
    assert.ok(only !== undefined);
    const stripped = {
      ...only.snapshot,
      files: only.snapshot.files.filter((file) => file.path !== 'payload/operational-recovery-record.json'),
    };
    const state = effectiveOperationalState(
      { verification: verified(fixture, chain), original_closure: PARTIAL, amendments: [stripped] },
      FIXTURE_DEPS,
    );
    assert.deepEqual(state, UNVERIFIED);
  });
});
