// Each step of design §8.16 on the probe fixture, one defect at a time: the index (step 1), every
// indexed byte and every digest the package records about itself (step 2), unindexed entries
// (step 3), references (step 4), the summary (step 5) and the amendment packages (step 6).
// A rebuilt final index (indexedProbePackage) isolates the older digests: a writer that rewrote
// a file and re-indexed the package still trips the evidence index, checkpoint or inventory.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareCodePoints, inventoryDigest } from '../../../src/evidence-package/assembly-inventory.ts';
import { verifyPackage } from '../../../src/evidence-package/package-verifier.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { DeploymentAssemblyInventory } from '../../../src/record-contract/records/group-a/deployment_assembly_inventory.ts';
import type {
  PackageIneligibilityReason,
  PackageVerification,
} from '../../../src/record-contract/records/group-c/package_verification.ts';
import { uuid } from '../../support/record-contract/record-builders.ts';
import { utf8 } from '../../support/evidence-package/package-files.ts';
import {
  FIXTURE_DEPS,
  PROBE_PATHS,
  amendmentChain,
  billingPayload,
  indexedProbePackage,
  lateEvidencePayload,
  probePackage,
  replaceFile,
  verificationInput,
  withoutFile,
} from '../../support/evidence-package/probe-package-fixtures.ts';
import type { FixtureAmendment, ProbePackage } from '../../support/evidence-package/probe-package-fixtures.ts';

function codesOf(verification: PackageVerification): readonly string[] {
  return verification.package_ineligibility_reasons.map((reason) => reason.code);
}

function verifyFiles(fixture: ProbePackage, files: readonly PackageFile[]): readonly string[] {
  return codesOf(
    verifyPackage({ ...verificationInput(fixture, [], null), original: { files, special_entries: [] } }, FIXTURE_DEPS),
  );
}

function rebuiltReasons(files: readonly PackageFile[]): readonly PackageIneligibilityReason[] {
  const rebuilt = indexedProbePackage(files);
  return verifyPackage(verificationInput(rebuilt, [], null), FIXTURE_DEPS).package_ineligibility_reasons;
}

function verifyRebuilt(files: readonly PackageFile[]): readonly string[] {
  return rebuiltReasons(files).map((reason) => reason.code);
}

function bytesOf(files: readonly PackageFile[], path: string): Uint8Array {
  return files.find((file) => file.path === path)?.bytes ?? new Uint8Array();
}

function editedJson(files: readonly PackageFile[], path: string, edit: Readonly<Record<string, unknown>>): Uint8Array {
  const record = JSON.parse(new TextDecoder().decode(bytesOf(files, path))) as Record<string, unknown>;
  return serializeRecordFile({ ...record, ...edit } as unknown as Parameters<typeof serializeRecordFile>[0]);
}

describe('§8.16 step 1: the package index', () => {
  it('INDEX_MISSING for an unparseable index', () => {
    const fixture = probePackage();
    assert.deepEqual(verifyFiles(fixture, replaceFile(fixture.files, 'package-index.json', utf8('{'))), [
      'INDEX_MISSING',
    ]);
  });

  it('INDEX_MISSING for the index of another execution', () => {
    const fixture = probePackage();
    const other = editedJson(fixture.files, 'package-index.json', { transport_probe_id: uuid(0x555) });
    assert.deepEqual(verifyFiles(fixture, replaceFile(fixture.files, 'package-index.json', other)), ['INDEX_MISSING']);
  });

  it('ALTERED_BYTES when the index names another manifest digest', () => {
    const fixture = probePackage();
    const forged = editedJson(fixture.files, 'package-index.json', {
      execution_manifest_sha256: sha256Hex(utf8('other')),
    });
    assert.deepEqual(verifyFiles(fixture, replaceFile(fixture.files, 'package-index.json', forged)), ['ALTERED_BYTES']);
  });
});

describe('§8.16 steps 2-3: indexed bytes and unindexed entries', () => {
  it('ALTERED_BYTES from the package index, its manifest digest and the evidence index when the manifest is absent', () => {
    const fixture = probePackage();
    const verification = verifyPackage(
      {
        ...verificationInput(fixture, [], null),
        original: { files: withoutFile(fixture.files, 'admission/execution-manifest.json'), special_entries: [] },
      },
      FIXTURE_DEPS,
    );
    const altered = verification.package_ineligibility_reasons.filter(
      (reason) => reason.artifact_path === 'admission/execution-manifest.json',
    );
    assert.deepEqual(
      altered.map((reason) => reason.code),
      ['ALTERED_BYTES', 'ALTERED_BYTES', 'ALTERED_BYTES'],
    );
  });

  it('ALTERED_BYTES for an indexed file that is absent', () => {
    const fixture = probePackage();
    const codes = verifyFiles(fixture, withoutFile(fixture.files, 'admission/environment-input.json'));
    assert.ok(codes.includes('ALTERED_BYTES'));
  });

  it('UNINDEXED_FILE for an extra file and for a symbolic link', () => {
    const fixture = probePackage();
    const extra = verifyFiles(fixture, [...fixture.files, { path: 'probe/extra.json', bytes: utf8('{}') }]);
    assert.deepEqual(extra, ['UNINDEXED_FILE']);
    const linked = verifyPackage(
      {
        ...verificationInput(fixture, [], null),
        original: { files: fixture.files, special_entries: [{ path: 'probe/link', type: 'symlink', mode: 0o120777 }] },
      },
      FIXTURE_DEPS,
    );
    assert.deepEqual(codesOf(linked), ['UNINDEXED_FILE']);
    assert.equal(linked.package_ineligibility_reasons[0]?.artifact_path, 'probe/link');
  });

  it('ALTERED_BYTES and UNRESOLVED_REFERENCE when a frozen file was rewritten and the package re-indexed', () => {
    const fixture = probePackage();
    const codes = verifyRebuilt(replaceFile(fixture.files, PROBE_PATHS.ledgerSnapshot, utf8('{"balance":"0.00"}\n')));
    assert.deepEqual(codes, ['ALTERED_BYTES', 'UNRESOLVED_REFERENCE']);
  });

  it('ALTERED_BYTES for an evidence index that cannot be read', () => {
    const fixture = probePackage();
    assert.deepEqual(verifyRebuilt(replaceFile(fixture.files, PROBE_PATHS.evidenceIndex, utf8('[]'))), [
      'ALTERED_BYTES',
    ]);
  });

  it('ALTERED_BYTES when the coordination journal no longer starts with its checkpointed prefix', () => {
    const fixture = probePackage();
    const journal = bytesOf(fixture.files, 'coordination/coordination-journal.jsonl');
    const rewritten = Uint8Array.of(...journal.slice(0, 3), 0x20, ...journal.slice(4));
    assert.deepEqual(verifyRebuilt(replaceFile(fixture.files, 'coordination/coordination-journal.jsonl', rewritten)), [
      'ALTERED_BYTES',
    ]);
    assert.deepEqual(verifyRebuilt(withoutFile(fixture.files, 'coordination/coordination-journal.jsonl')), [
      'ALTERED_BYTES',
    ]);
  });

  it('ALTERED_BYTES for a checkpoint that cannot be read', () => {
    const fixture = probePackage();
    const codes = verifyRebuilt(
      replaceFile(fixture.files, 'coordination/coordination-prefix-checkpoint.json', utf8('{}')),
    );
    assert.ok(codes.every((code) => code === 'ALTERED_BYTES') && codes.length >= 1);
  });

  it('ALTERED_BYTES when the assembly copy no longer matches its inventory', () => {
    const fixture = probePackage();
    assert.deepEqual(verifyRebuilt(replaceFile(fixture.files, PROBE_PATHS.assemblyBundle, utf8('export {};\n'))), [
      'ALTERED_BYTES',
    ]);
    assert.deepEqual(
      verifyRebuilt([...fixture.files, { path: 'admission/deployment-assembly/extra.json', bytes: utf8('{}') }]),
      ['ALTERED_BYTES'],
    );
  });

  it('ALTERED_BYTES for an inventory that cannot vouch for the assembly', () => {
    const fixture = probePackage();
    const path = 'admission/deployment-assembly.inventory.json';
    const elsewhere = editedJson(fixture.files, path, { assembly_path: 'admission/other' });
    const forged = editedJson(fixture.files, path, { inventory_sha256: sha256Hex(utf8('x')) });
    for (const bytes of [utf8('{'), elsewhere, forged]) {
      const codes = verifyRebuilt(replaceFile(fixture.files, path, bytes));
      assert.ok(codes.length >= 1 && codes.every((code) => code === 'ALTERED_BYTES'), JSON.stringify(codes));
    }
  });

  // Each entry still matches its stored file and the digest is recomputed over the list as
  // written, so only the code-point order rule (the inventory schema leaves it to this verifier)
  // can reject a reordered or duplicated list.
  it('ALTERED_BYTES for an inventory out of code-point order or listing a path twice', () => {
    const fixture = probePackage();
    const path = 'admission/deployment-assembly.inventory.json';
    const inventory = JSON.parse(new TextDecoder().decode(bytesOf(fixture.files, path))) as DeploymentAssemblyInventory;
    const [first, second] = inventory.files;
    assert.ok(second !== undefined && compareCodePoints(first.path, second.path) < 0, 'the fixture lists two files');
    const reordered = [second, first];
    const duplicated = [first, { ...first, mode: first.mode === '0755' ? '0644' : '0755' }, second];
    for (const [listed, found] of [
      [reordered, `files[1].path "${first.path}" follows "${second.path}"`],
      [duplicated, `files[1].path "${first.path}" follows "${first.path}"`],
    ] as const) {
      const bytes = editedJson(fixture.files, path, { files: listed, inventory_sha256: inventoryDigest(listed) });
      const reasons = rebuiltReasons(replaceFile(fixture.files, path, bytes));
      // The probe's evidence index froze the inventory file too, so rewriting it also trips that
      // older digest; the inventory's own reason is the one this rule adds.
      const [frozen, ...own] = reasons;
      assert.ok(frozen?.detail.startsWith('evidence index "probe/evidence-index.json"'), JSON.stringify(reasons));
      assert.deepEqual(own, [
        {
          code: 'ALTERED_BYTES',
          subject: 'BR-RUA-044',
          detail: `"${path}" cannot vouch for the bytes it froze: ${found}; expected each path once, in strictly ascending code-point order`,
          artifact_path: path,
        },
      ]);
    }
  });

  it('accepts a package without checkpoint or inventory files', () => {
    const fixture = probePackage();
    const files = withoutFile(
      withoutFile(fixture.files, 'coordination/coordination-prefix-checkpoint.json'),
      'admission/deployment-assembly.inventory.json',
    );
    const codes = verifyRebuilt(files);
    assert.ok(
      codes.every((code) => code === 'ALTERED_BYTES'),
      JSON.stringify(codes),
    );
  });
});

describe('§8.16 step 5: the summary', () => {
  it('NON_TERMINAL_STATUS for a running or unstarted cleanup', () => {
    for (const status of ['running', 'not_started'] as const) {
      const fixture = probePackage({ cleanup_status: status });
      assert.deepEqual(codesOf(verifyPackage(verificationInput(fixture, [], null), FIXTURE_DEPS)), [
        'NON_TERMINAL_STATUS',
      ]);
    }
  });

  it('accepts partial and failed cleanup as terminal', () => {
    for (const status of ['partial', 'failed'] as const) {
      const fixture = probePackage({ cleanup_status: status });
      assert.deepEqual(codesOf(verifyPackage(verificationInput(fixture, [], null), FIXTURE_DEPS)), []);
    }
  });

  it('NON_TERMINAL_STATUS for an absent, unreadable or foreign summary', () => {
    const fixture = probePackage();
    const path = 'summary/transport-probe-summary.json';
    assert.ok(verifyRebuilt(withoutFile(fixture.files, path)).includes('NON_TERMINAL_STATUS'));
    assert.ok(verifyRebuilt(replaceFile(fixture.files, path, utf8('{}'))).includes('NON_TERMINAL_STATUS'));
    const foreign = editedJson(fixture.files, path, { transport_probe_id: uuid(0x556) });
    assert.deepEqual(verifyRebuilt(replaceFile(fixture.files, path, foreign)), ['NON_TERMINAL_STATUS']);
  });
});

describe('§8.16 step 6: amendment packages', () => {
  function verifyChain(fixture: ProbePackage, chain: readonly FixtureAmendment[]): readonly string[] {
    return codesOf(verifyPackage(verificationInput(fixture, chain, chain.at(-1)?.index_sha256 ?? null), FIXTURE_DEPS));
  }

  function withFiles(amendment: FixtureAmendment, files: readonly PackageFile[]): FixtureAmendment {
    return { ...amendment, snapshot: { ...amendment.snapshot, files } };
  }

  it('ALTERED_BYTES for an amendment without a readable index', () => {
    const fixture = probePackage();
    const [only] = amendmentChain(fixture, [{ kind: 'BILLING', payload: [billingPayload()] }]);
    assert.ok(only !== undefined);
    const noIndex = withFiles(only, withoutFile(only.snapshot.files, 'amendment-index.json'));
    assert.deepEqual(codesOf(verifyPackage(verificationInput(fixture, [noIndex], null), FIXTURE_DEPS)), [
      'ALTERED_BYTES',
    ]);
    const badIndex = withFiles(only, replaceFile(only.snapshot.files, 'amendment-index.json', utf8('{}')));
    assert.deepEqual(codesOf(verifyPackage(verificationInput(fixture, [badIndex], null), FIXTURE_DEPS)), [
      'ALTERED_BYTES',
    ]);
  });

  it('ALTERED_BYTES and UNINDEXED_FILE inside an amendment', () => {
    const fixture = probePackage();
    const [only] = amendmentChain(fixture, [{ kind: 'BILLING', payload: [billingPayload()] }]);
    assert.ok(only !== undefined);
    const altered = withFiles(only, replaceFile(only.snapshot.files, 'payload/billing-import.json', utf8('{}')));
    assert.deepEqual(verifyChain(fixture, [altered]), ['ALTERED_BYTES']);
    const extra = withFiles(only, [...only.snapshot.files, { path: 'payload/notes.txt', bytes: utf8('x') }]);
    const linked: FixtureAmendment = {
      ...only,
      snapshot: { ...only.snapshot, special_entries: [{ path: 'payload/link', type: 'symlink', mode: 0 }] },
    };
    assert.deepEqual(verifyChain(fixture, [extra]), ['UNINDEXED_FILE']);
    assert.deepEqual(verifyChain(fixture, [linked]), ['UNINDEXED_FILE']);
  });

  it('CONTRADICTORY_CHAIN when the final assessment is contradictory, until a reassessment is selected', () => {
    const fixture = probePackage();
    const contradicted = amendmentChain(fixture, [
      { kind: 'LATE_EVIDENCE', payload: [lateEvidencePayload(fixture, 'contradictory')] },
    ]);
    const verification = verifyPackage(
      verificationInput(fixture, contradicted, contradicted.at(-1)?.index_sha256 ?? null),
      FIXTURE_DEPS,
    );
    assert.deepEqual(codesOf(verification), ['CONTRADICTORY_CHAIN']);
    assert.match(verification.package_ineligibility_reasons[0]?.detail ?? '', /late_evidence_status is contradictory/);
    const reassessed = amendmentChain(fixture, [
      { kind: 'LATE_EVIDENCE', payload: [lateEvidencePayload(fixture, 'contradictory')] },
      { kind: 'REASSESSMENT', payload: [lateEvidencePayload(fixture, 'consistent')] },
    ]);
    assert.deepEqual(verifyChain(fixture, reassessed), []);
  });

  it('CONTRADICTORY_CHAIN when the final assessment cannot be read', () => {
    const fixture = probePackage();
    const unreadable = amendmentChain(fixture, [
      { kind: 'REASSESSMENT', payload: [{ path: 'payload/late-evidence-assessment.json', bytes: utf8('{}') }] },
    ]);
    assert.deepEqual(verifyChain(fixture, unreadable), ['CONTRADICTORY_CHAIN']);
    const [only] = unreadable;
    assert.ok(only !== undefined);
    const absent = withFiles(only, withoutFile(only.snapshot.files, 'payload/late-evidence-assessment.json'));
    assert.deepEqual(verifyChain(fixture, [absent]), ['ALTERED_BYTES', 'CONTRADICTORY_CHAIN']);
  });

  it('resolves a cross-package reference only to a known package index', () => {
    const fixture = probePackage();
    const known = sha256Hex(utf8('run package'));
    const files = replaceFile(
      fixture.files,
      'late-evidence/late-evidence-assessment.json',
      utf8(
        JSON.stringify({
          evidence_refs: [{ artifact_path: 'x.json', artifact_sha256: known, package_index_sha256: known }],
        }),
      ),
    );
    const rebuilt = indexedProbePackage(files);
    const unknown = verifyPackage(verificationInput(rebuilt, [], null), FIXTURE_DEPS);
    const accepted = verifyPackage(
      { ...verificationInput(rebuilt, [], null), referenced_package_indexes: [known] },
      FIXTURE_DEPS,
    );
    // The summary's reference to the rewritten assessment fails in both; only the unknown index differs.
    const crossPackage = (verification: PackageVerification): number =>
      verification.package_ineligibility_reasons.filter((reason) =>
        reason.detail.includes('unknown package_index_sha256'),
      ).length;
    assert.deepEqual([crossPackage(unknown), crossPackage(accepted)], [1, 0]);
  });
});
