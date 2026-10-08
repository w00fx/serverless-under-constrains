// AC-RUA-022 (BR-RUA-043, BR-RUA-044; design §8.16): the package verifier validates every indexed
// byte, chain parent, sequence, reference and known descendant, and returns `eligible` only for a
// complete noncontradictory selected chain. Eligibility never implies preservation,
// implementation, comparison or study-completion success: the verification has no verdict field.
// The six §14 cases come first; the remaining cases cover each other step of §8.16.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { PackageVerification } from '../../../src/record-contract/records/group-c/package_verification.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { verifyPackage } from '../../../src/evidence-package/package-verifier.ts';
import type { PackageVerificationInput } from '../../../src/evidence-package/package-verifier.ts';
import { AMENDMENT_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { AliasingDigest } from '../../support/evidence-package/aliasing-digest.ts';
import {
  FIXTURE_DEPS,
  FIXTURE_VALIDATOR,
  amendmentChain,
  billingPayload,
  lateEvidencePayload,
  probePackage,
  verificationInput,
} from '../../support/evidence-package/probe-package-fixtures.ts';
import type { FixtureAmendment, ProbePackage } from '../../support/evidence-package/probe-package-fixtures.ts';

const VERDICT_FIELDS = [
  'preservation_verdict',
  'implementation_validation_status',
  'comparison_eligibility',
  'study_completion',
  'transport_probe_verdict',
];

function codes(verification: PackageVerification): readonly string[] {
  return verification.package_ineligibility_reasons.map((reason) => reason.code);
}

function headOf(chain: readonly FixtureAmendment[]): Sha256Hex | null {
  return chain.at(-1)?.index_sha256 ?? null;
}

function threeAmendments(fixture: ProbePackage): readonly FixtureAmendment[] {
  return amendmentChain(fixture, [
    { kind: 'LATE_EVIDENCE', payload: [lateEvidencePayload(fixture, 'contradictory')] },
    { kind: 'REASSESSMENT', payload: [lateEvidencePayload(fixture, 'consistent')] },
    { kind: 'BILLING', payload: [billingPayload()] },
  ]);
}

describe('AC-RUA-022 package verification', () => {
  it('altered-byte', () => {
    const fixture = probePackage();
    const files = fixture.files.map((file) =>
      file.path === 'probe/ledger/ledger-snapshot.json'
        ? { path: file.path, bytes: Uint8Array.of(...file.bytes.slice(0, -2), 0x21, 0x0a) }
        : file,
    );
    const verification = verifyPackage(
      { ...verificationInput(fixture, [], null), original: { files, special_entries: [] } },
      FIXTURE_DEPS,
    );
    assert.equal(verification.package_eligibility, 'ineligible');
    // The final index and the probe's evidence index both froze the ledger's digest, and the
    // derived probe result cites it, so the edit trips all three.
    assert.deepEqual(
      verification.package_ineligibility_reasons.map((reason) => [reason.code, reason.artifact_path]),
      [
        ['ALTERED_BYTES', 'probe/ledger/ledger-snapshot.json'],
        ['ALTERED_BYTES', 'probe/ledger/ledger-snapshot.json'],
        ['UNRESOLVED_REFERENCE', 'probe/derived/transport-probe-result.json'],
      ],
    );
  });

  it('broken-parent', () => {
    const fixture = probePackage();
    const [first, second] = amendmentChain(fixture, [
      { kind: 'BILLING', payload: [billingPayload()] },
      { kind: 'BILLING', payload: [billingPayload()] },
    ]);
    assert.ok(first !== undefined && second !== undefined);
    const orphan = amendmentChain({ ...fixture, index_sha256: sha256Hex(Uint8Array.of(1)) }, [
      { kind: 'BILLING', payload: [billingPayload()] },
      { kind: 'BILLING', payload: [billingPayload()] },
    ])[1];
    assert.ok(orphan !== undefined);
    const verification = verifyPackage(verificationInput(fixture, [first, orphan], orphan.index_sha256), FIXTURE_DEPS);
    assert.equal(verification.package_eligibility, 'ineligible');
    // The orphan names another original index and a parent that is not amendment 1, so amendment
    // 1 is known but outside the chain selected at the orphan.
    assert.deepEqual(codes(verification), ['BROKEN_PARENT', 'BROKEN_PARENT', 'UNSELECTED_DESCENDANT']);
  });

  it('sequence-gap', () => {
    const fixture = probePackage();
    const [first, , third] = threeAmendments(fixture);
    assert.ok(first !== undefined && third !== undefined);
    const verification = verifyPackage(verificationInput(fixture, [first, third], third.index_sha256), FIXTURE_DEPS);
    // Amendment 3 names the absent amendment 2 as its parent, so amendment 1 is left unselected.
    assert.deepEqual(codes(verification), ['BROKEN_PARENT', 'SEQUENCE_GAP', 'UNSELECTED_DESCENDANT']);
    assert.equal(verification.package_eligibility, 'ineligible');
  });

  it('cycle', () => {
    const fixture = probePackage();
    const [first, second] = amendmentChain(fixture, [
      { kind: 'BILLING', payload: [billingPayload()] },
      { kind: 'BILLING', payload: [billingPayload()] },
    ]);
    assert.ok(first !== undefined && second !== undefined);
    // Amendment 1 names amendment 2 as its parent; the aliasing digest gives the indexes digests
    // that name each other, which real SHA-256 cannot produce.
    const indexOf = (amendment: FixtureAmendment): Uint8Array =>
      amendment.snapshot.files.find((file) => file.path === AMENDMENT_PATHS.amendmentIndex)?.bytes ?? new Uint8Array();
    const firstIndex = JSON.parse(new TextDecoder().decode(indexOf(first))) as Record<string, unknown>;
    const looped = { ...firstIndex, parent_amendment_index_sha256: second.index_sha256 };
    const loopedBytes = serializeRecordFile(looped as unknown as Parameters<typeof serializeRecordFile>[0]);
    const aliasing = new AliasingDigest();
    aliasing.alias(loopedBytes, first.index_sha256);
    const loopedFirst: FixtureAmendment = {
      index_sha256: first.index_sha256,
      snapshot: {
        ...first.snapshot,
        files: first.snapshot.files.map((file) =>
          file.path === AMENDMENT_PATHS.amendmentIndex ? { path: file.path, bytes: loopedBytes } : file,
        ),
      },
    };
    const verification = verifyPackage(verificationInput(fixture, [loopedFirst, second], second.index_sha256), {
      validator: FIXTURE_VALIDATOR,
      digest: aliasing.digest,
    });
    // Sequence 1 must name no parent, so the loop is also a broken parent.
    assert.deepEqual(codes(verification), ['BROKEN_PARENT', 'CYCLE']);
    assert.equal(verification.package_eligibility, 'ineligible');
    assert.ok(verification.selected_chain.length <= 2);
  });

  it('unknown-descendant', () => {
    const fixture = probePackage();
    const chain = threeAmendments(fixture);
    const selected = chain[1];
    assert.ok(selected !== undefined);
    const verification = verifyPackage(verificationInput(fixture, chain, selected.index_sha256), FIXTURE_DEPS);
    assert.deepEqual(codes(verification), ['UNSELECTED_DESCENDANT']);
    assert.equal(verification.known_descendants.length, 3);
    assert.deepEqual(
      verification.selected_chain.map((link) => link.sequence),
      [1, 2],
    );
  });

  it('complete-chain-eligible', () => {
    const fixture = probePackage();
    const chain = threeAmendments(fixture);
    const before = fixture.files.map((file) => [file.path, Uint8Array.from(file.bytes)] as const);
    const verification = verifyPackage(verificationInput(fixture, chain, headOf(chain)), FIXTURE_DEPS);
    assert.deepEqual(verification.package_ineligibility_reasons, []);
    assert.equal(verification.package_eligibility, 'eligible');
    // The frozen result, its verdict included, is byte-for-byte what it was before verification.
    assert.deepEqual(
      fixture.files.map((file) => [file.path, file.bytes] as const),
      before,
    );
    assert.equal(verification.original_package_index_sha256, fixture.index_sha256);
    assert.equal(verification.selected_amendment_head_sha256, headOf(chain));
    assert.deepEqual(
      verification.selected_chain.map((link) => [link.sequence, link.amendment_kind, link.amendment_index_sha256]),
      chain.map((amendment, position) => [
        position + 1,
        ['LATE_EVIDENCE', 'REASSESSMENT', 'BILLING'][position],
        amendment.index_sha256,
      ]),
    );
    assert.deepEqual(verification.known_descendants, verification.selected_chain);
    // Eligibility implies no preservation, implementation, comparison or completion success: the
    // verification carries no verdict field at all.
    for (const field of VERDICT_FIELDS) {
      assert.equal(Object.hasOwn(verification, field), false, `verification carries ${field}`);
    }
    assert.ok(
      FIXTURE_VALIDATOR.validateAs('package_verification', JSON.parse(JSON.stringify(verification)) as never).valid,
    );
  });
});

describe('package verification of the original package', () => {
  it('is eligible with no amendment and no selected head', () => {
    const fixture = probePackage();
    const verification = verifyPackage(verificationInput(fixture, [], null), FIXTURE_DEPS);
    assert.deepEqual(codes(verification), []);
    assert.deepEqual(verification.selected_chain, []);
    assert.equal(verification.selected_amendment_head_sha256, null);
    assert.deepEqual(
      Object.keys(verification).filter((key) => key.endsWith('_id')),
      ['transport_probe_id'],
    );
  });

  it('INDEX_MISSING when the package index is absent, with the digest of no bytes', () => {
    const fixture = probePackage();
    const files = fixture.files.filter((file) => file.path !== 'package-index.json');
    const input: PackageVerificationInput = {
      ...verificationInput(fixture, [], null),
      original: { files, special_entries: [] },
    };
    const verification = verifyPackage(input, FIXTURE_DEPS);
    assert.deepEqual(codes(verification), ['INDEX_MISSING']);
    assert.equal(verification.original_package_index_sha256, sha256Hex(new Uint8Array()));
  });
});
