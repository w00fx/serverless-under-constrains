// What a selected BILLING amendment adds to the safety standing (BR-RUA-046, BR-RUA-047,
// OR-RUA-005): the last one in the verified chain decides; a breach blocks, a verified bill resolves
// a pending one, and an unreadable or foreign import leaves safety unverified.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PackageVerification } from '../../../src/record-contract/records/group-c/package_verification.ts';
import { verifyPackage } from '../../../src/evidence-package/package-verifier.ts';
import { AMENDMENT_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { billedSafetyStanding } from '../../../src/variant-validation/billing-safety.ts';
import type { SafetyStanding } from '../../../src/variant-validation/safety-standing.ts';
import { validationReason } from '../../../src/variant-validation/validation-reasons.ts';
import { FIXTURE_DEPS } from '../../support/evidence-package/probe-package-fixtures.ts';
import { digest } from '../../support/record-contract/record-builders.ts';
import { utf8 } from '../../support/evidence-package/package-files.ts';
import {
  amendmentChain,
  billingPayload,
  recoveryPayload,
} from '../../golden/variant-validation/support/validation-amendments.ts';
import type {
  GoldenAmendment,
  GoldenAmendmentSpec,
} from '../../golden/variant-validation/support/validation-amendments.ts';
import {
  CLEAN_CLOSURE,
  GOLDEN_IDENTITY,
  validationPackage,
} from '../../golden/variant-validation/support/validation-package.ts';
import { goldenAt } from '../../golden/variant-validation/support/validation-records.ts';

const FIXTURE = validationPackage();
const PENDING: SafetyStanding = { standing: 'billing_pending' };
const UNVERIFIED: SafetyStanding = {
  standing: 'unverified',
  reasons: [
    validationReason('SAFETY_UNVERIFIED', 'safety_status', 'ACTIVE_TIME is unverified; expected within limits'),
  ],
};

function chainOf(specs: readonly GoldenAmendmentSpec[]): {
  chain: readonly GoldenAmendment[];
  verification: PackageVerification;
} {
  const chain = amendmentChain(FIXTURE, specs);
  const verification = verifyPackage(
    {
      identity: GOLDEN_IDENTITY,
      original: { files: FIXTURE.files, special_entries: [] },
      amendments: chain.map((amendment) => amendment.snapshot),
      selected_head: chain.at(-1)?.index_sha256 ?? null,
      referenced_package_indexes: [],
      evaluated_at: goldenAt(30_000),
    },
    FIXTURE_DEPS,
  );
  return { chain, verification };
}

function standingAfter(standing: SafetyStanding, specs: readonly GoldenAmendmentSpec[]): SafetyStanding {
  const { chain, verification } = chainOf(specs);
  return billedSafetyStanding(
    standing,
    verification,
    chain.map((amendment) => amendment.snapshot),
    FIXTURE_DEPS,
  );
}

function codesOf(standing: SafetyStanding): readonly string[] {
  return standing.standing === 'breached' || standing.standing === 'unverified'
    ? standing.reasons.map((reason) => reason.code)
    : [];
}

describe('billedSafetyStanding', () => {
  it('keeps the standing when the chain has no BILLING amendment', () => {
    assert.equal(
      standingAfter(PENDING, [{ kind: 'OPERATIONAL_RECOVERY', payload: recoveryPayload(FIXTURE, CLEAN_CLOSURE) }]),
      PENDING,
    );
    assert.equal(standingAfter(PENDING, []), PENDING);
  });

  it('makes a breached billed cost a known safety breach, keeping earlier reasons', () => {
    const standing = standingAfter(UNVERIFIED, [{ kind: 'BILLING', payload: billingPayload(FIXTURE, 'breached') }]);
    assert.equal(standing.standing, 'breached');
    assert.deepEqual(codesOf(standing), ['SAFETY_UNVERIFIED', 'SAFETY_BREACHED']);
    assert.deepEqual(
      codesOf(standingAfter(PENDING, [{ kind: 'BILLING', payload: billingPayload(FIXTURE, 'breached') }])),
      ['SAFETY_BREACHED'],
    );
  });

  it('resolves a pending bill once the billed cost is within its limit, and changes nothing else', () => {
    const within = [{ kind: 'BILLING', payload: billingPayload(FIXTURE, 'within_limit') }] as const;
    assert.deepEqual(standingAfter(PENDING, within), { standing: 'within_limits' });
    assert.equal(standingAfter(UNVERIFIED, within), UNVERIFIED);
  });

  it('keeps the standing while the bill is still unverified', () => {
    assert.equal(
      standingAfter(PENDING, [{ kind: 'BILLING', payload: billingPayload(FIXTURE, 'unverified') }]),
      PENDING,
    );
  });

  it('lets the last BILLING amendment of the chain decide', () => {
    const specs = [
      { kind: 'BILLING', payload: billingPayload(FIXTURE, 'breached') },
      { kind: 'BILLING', payload: billingPayload(FIXTURE, 'within_limit') },
    ] as const;
    assert.deepEqual(standingAfter(PENDING, specs), { standing: 'within_limits' });
  });

  it('is unverified when the selected amendment is not among the amendments', () => {
    const { verification } = chainOf([{ kind: 'BILLING', payload: billingPayload(FIXTURE, 'within_limit') }]);
    const standing = billedSafetyStanding(PENDING, verification, [], FIXTURE_DEPS);
    assert.deepEqual(codesOf(standing), ['SAFETY_UNVERIFIED']);
    assert.ok(
      standing.standing === 'unverified' && (standing.reasons[0]?.detail ?? '').includes('is not among the amendments'),
    );
  });

  it('is unverified when the billing import cannot be read', () => {
    const payload = [{ path: AMENDMENT_PATHS.billingImport, bytes: utf8('{"billing":') }];
    const standing = standingAfter(PENDING, [{ kind: 'BILLING', payload }]);
    assert.ok(
      standing.standing === 'unverified' && (standing.reasons[0]?.detail ?? '').includes('is not one JSON document'),
    );
  });

  it('is unverified when the billing import amends another package', () => {
    const standing = standingAfter(PENDING, [
      { kind: 'BILLING', payload: billingPayload(FIXTURE, 'within_limit', digest('other package')) },
    ]);
    assert.ok(standing.standing === 'unverified' && (standing.reasons[0]?.detail ?? '').includes('amends package'));
  });
});
