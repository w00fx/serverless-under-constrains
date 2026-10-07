// The study-completion inputs from outside the run package (BR-RUA-054): the billed-cost checks of
// the selected BILLING amendments (only an import of this original package counts), the selection
// flags, and the selected qualification judged as admission's A10 judges it. The scripted reader
// the command tests use is held to the stored reader's answer here (its conformance test).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { QualificationSelection } from '../../../src/admission/admission-ports.ts';
import { AMENDMENT_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { verifyPackage } from '../../../src/evidence-package/package-verifier.ts';
import {
  StoredQualificationReader,
  parseSelection,
  selectedBilledCostChecks,
} from '../../../src/operator-cli/run-completion-inputs.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { Sha256Hex, UtcMillis, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { utf8 } from '../../support/evidence-package/package-files.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { loadProbeCase } from '../../golden/transport-qualification/verdict/support/probe-golden.ts';
import {
  PROBE_IDENTITY,
  amendmentChain as probeAmendmentChain,
  probePackage,
} from '../../golden/transport-qualification/verdict/support/probe-package.ts';
import { billingPayload as probeBillingPayload } from '../transport-qualification/verdict/support/probe-amendment-payloads.ts';
import { amendmentChain, billingPayload } from '../../golden/variant-validation/support/validation-amendments.ts';
import type { GoldenAmendment } from '../../golden/variant-validation/support/validation-amendments.ts';
import { GOLDEN_IDENTITY, validationPackage } from '../../golden/variant-validation/support/validation-package.ts';
import { HARNESS_NOW } from './support/cli-harness.ts';
import { ScriptedQualificationReader } from './support/scripted-qualification-reader.ts';
import { storePackage } from './support/stored-packages.ts';

const validator = createRecordValidator();
const deps = { validator, digest: sha256Hex };
const fixture = validationPackage();

function verificationOf(chain: readonly GoldenAmendment[]): ReturnType<typeof verifyPackage> {
  return verifyPackage(
    {
      identity: GOLDEN_IDENTITY,
      original: { files: fixture.files, special_entries: [] },
      amendments: chain.map((amendment) => amendment.snapshot),
      selected_head: chain.at(-1)?.index_sha256 ?? null,
      referenced_package_indexes: [],
      evaluated_at: HARNESS_NOW as UtcMillis,
    },
    deps,
  );
}

// The chain's snapshots with the billing import's bytes replaced after the chain was verified.
function withBillingBytes(chain: readonly GoldenAmendment[], bytes: Uint8Array): readonly GoldenAmendment[] {
  return chain.map((amendment) => ({
    ...amendment,
    snapshot: {
      ...amendment.snapshot,
      files: amendment.snapshot.files.map((file) =>
        file.path === AMENDMENT_PATHS.billingImport ? { path: file.path, bytes } : file,
      ),
    },
  }));
}

describe('selectedBilledCostChecks', () => {
  it('reads the check of every selected BILLING amendment of this package', () => {
    const chain = amendmentChain(fixture, [
      { kind: 'BILLING', payload: billingPayload(fixture, 'within_limit') },
      { kind: 'BILLING', payload: billingPayload(fixture, 'breached') },
    ]);
    const verification = verificationOf(chain);
    assert.equal(verification.package_eligibility, 'eligible');
    const checks = selectedBilledCostChecks(
      verification,
      chain.map((amendment) => amendment.snapshot),
      validator,
    );
    assert.deepEqual(checks, ['within_limit', 'breached']);
  });

  it('is empty without a selected chain', () => {
    assert.deepEqual(selectedBilledCostChecks(verificationOf([]), [], validator), []);
  });

  it('ignores an import of another original package', () => {
    const chain = amendmentChain(fixture, [
      { kind: 'BILLING', payload: billingPayload(fixture, 'breached', 'c'.repeat(64) as Sha256Hex) },
    ]);
    const amendments = chain.map((amendment) => amendment.snapshot);
    assert.deepEqual(selectedBilledCostChecks(verificationOf(chain), amendments, validator), []);
  });

  it('ignores a selected amendment it cannot find or read', () => {
    const chain = amendmentChain(fixture, [{ kind: 'BILLING', payload: billingPayload(fixture, 'breached') }]);
    const verification = verificationOf(chain);
    const snapshots = (replaced: readonly GoldenAmendment[]): readonly GoldenAmendment['snapshot'][] =>
      replaced.map((amendment) => amendment.snapshot);
    assert.deepEqual(selectedBilledCostChecks(verification, [], validator), []);
    assert.deepEqual(
      selectedBilledCostChecks(verification, snapshots(withBillingBytes(chain, utf8('{'))), validator),
      [],
    );
    assert.deepEqual(
      selectedBilledCostChecks(
        verification,
        snapshots(withBillingBytes(chain, utf8('{"record_type":"billing_import"}'))),
        validator,
      ),
      [],
    );
    const withoutIndex = chain.map((amendment) => ({
      ...amendment.snapshot,
      files: amendment.snapshot.files.filter((file) => file.path !== AMENDMENT_PATHS.amendmentIndex),
    }));
    assert.deepEqual(selectedBilledCostChecks(verification, withoutIndex, validator), []);
  });
});

describe('parseSelection', () => {
  const probe = PROBE_IDENTITY.transport_probe_id;
  const index = 'a'.repeat(64);

  it('reads the probe, its index and the optional head', () => {
    assert.deepEqual(
      parseSelection(
        new Map([
          ['probe', probe],
          ['probe-index', index],
        ]),
      ),
      {
        ok: true,
        value: { transport_probe_id: probe, original_package_index_sha256: index, amendment_head_sha256: null },
      },
    );
    const head = 'b'.repeat(64);
    const parsed = parseSelection(
      new Map([
        ['probe', probe],
        ['probe-index', index],
        ['probe-head', head],
      ]),
    );
    assert.equal(parsed.ok && parsed.value.amendment_head_sha256, head);
  });

  it('refuses missing or malformed values with the expected shape', () => {
    assert.deepEqual(parseSelection(new Map()), {
      ok: false,
      error: {
        code: 'USAGE_ERROR',
        subject: 'operator-cli',
        detail: '--probe "" is not a probe id; expected a lowercase UUIDv4',
      },
    });
    const noIndex = parseSelection(new Map([['probe', probe]]));
    assert.equal(noIndex.ok, false);
    assert.equal(
      noIndex.error.detail,
      '--probe-index "" is not a digest; expected 64 lowercase hexadecimal characters',
    );
    const badHead = parseSelection(
      new Map([
        ['probe', probe],
        ['probe-index', index],
        ['probe-head', 'x'],
      ]),
    );
    assert.equal(badHead.ok, false);
    assert.match(badHead.error.detail, /^--probe-head "x" is not a digest/);
  });
});

describe('StoredQualificationReader', () => {
  const clock = new VirtualTimeScheduler({ wallEpochMs: Date.parse(HARNESS_NOW) });

  async function storedProbe(): Promise<{
    readonly fs: Awaited<ReturnType<typeof storePackage>>;
    readonly index: Sha256Hex;
    readonly snapshot: Sha256Hex;
  }> {
    const built = probePackage((await loadProbeCase('ac021-probe-verdict-pass')).files);
    const snapshot = built.files.find((file) => file.path === 'admission/transport-scope-snapshot.json');
    assert.ok(snapshot !== undefined);
    return {
      fs: await storePackage(PROBE_IDENTITY, built.files),
      index: built.index_sha256,
      snapshot: sha256Hex(snapshot.bytes),
    };
  }

  function selectionOf(index: Sha256Hex, probe: Uuid4 = PROBE_IDENTITY.transport_probe_id): QualificationSelection {
    return { transport_probe_id: probe, original_package_index_sha256: index, amendment_head_sha256: null };
  }

  it('selects a usable probe with its stored transport-scope snapshot, as the scripted reader does', async () => {
    const { fs, index, snapshot } = await storedProbe();
    const selection = selectionOf(index);
    const stored = await new StoredQualificationReader(clock, validator).readSelected(selection, fs);
    const scripted = await new ScriptedQualificationReader(snapshot).readSelected(selection, fs);
    assert.deepEqual(stored, {
      selected: {
        qualification: { transport_probe_id: PROBE_IDENTITY.transport_probe_id, original_package_index_sha256: index },
        transport_scope_snapshot_sha256: snapshot,
      },
      reasons: [],
    });
    assert.deepEqual(scripted, stored);
  });

  it('keeps an explicit head in the selected qualification, as the scripted reader does', async () => {
    const built = probePackage((await loadProbeCase('ac021-probe-verdict-pass')).files);
    const chain = probeAmendmentChain(built, [
      { kind: 'BILLING', payload: [probeBillingPayload(built, 'within_limit')] },
    ]);
    const fs = await storePackage(PROBE_IDENTITY, built.files, chain);
    const head = chain.at(-1)?.index_sha256 ?? null;
    const selection = { ...selectionOf(built.index_sha256), amendment_head_sha256: head };
    const stored = await new StoredQualificationReader(clock, validator).readSelected(selection, fs);
    assert.deepEqual(stored.reasons, []);
    assert.equal(stored.selected?.qualification.amendment_head_sha256, head);
    const scripted = await new ScriptedQualificationReader(
      stored.selected.transport_scope_snapshot_sha256,
    ).readSelected(selection, fs);
    assert.deepEqual(scripted, stored);
  });

  it('selects nothing for a head the probe package does not have', async () => {
    const { fs, index } = await storedProbe();
    const stored = await new StoredQualificationReader(clock, validator).readSelected(
      { ...selectionOf(index), amendment_head_sha256: 'd'.repeat(64) as Sha256Hex },
      fs,
    );
    assert.equal(stored.selected, undefined);
    assert.ok(stored.reasons.length > 0);
  });

  it('selects nothing, with admission reasons, when the selection does not qualify', async () => {
    const { fs } = await storedProbe();
    const mismatch = await new StoredQualificationReader(clock, validator).readSelected(
      selectionOf('e'.repeat(64) as Sha256Hex),
      fs,
    );
    assert.equal(mismatch.selected, undefined);
    assert.ok(mismatch.reasons.some((reason) => reason.code === 'SELECTION_MISMATCH'));
    const absent = await new StoredQualificationReader(clock, validator).readSelected(
      selectionOf('e'.repeat(64) as Sha256Hex, '0b6d7a52-3c4e-4f80-9a1b-2c3d4e5f6a7b' as Uuid4),
      fs,
    );
    assert.equal(absent.reasons[0]?.code, 'PROBE_PACKAGE_UNREADABLE');
    const refused = await new ScriptedQualificationReader(undefined, absent.reasons).readSelected(
      selectionOf('e'.repeat(64) as Sha256Hex),
      fs,
    );
    assert.deepEqual(refused, absent);
  });
});
