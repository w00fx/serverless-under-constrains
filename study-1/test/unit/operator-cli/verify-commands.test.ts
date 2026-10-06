// `rua probe verify` and `rua validation verify` over committed golden packages stored in the
// evidence root (design §11, §8.11, §8.15): the answer decides the exit code (0 usable / verified,
// 5 otherwise), the verifier outputs are written under `verifications/<id>/` with the stamped
// instant, and operand, head, read and write failures map to usage (2), verification (5) and
// internal (10) outcomes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PackageFileSystem } from '../../../src/evidence-package/package-file-system.ts';
import { PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import {
  ProbeVerifyCommand,
  ValidationVerifyCommand,
  notHeld,
  verifiedReport,
} from '../../../src/operator-cli/verify-commands.ts';
import { verifyPackage } from '../../../src/evidence-package/package-verifier.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { ExecutionIdentity, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { VerificationKind } from '../../../src/evidence-package/package-layout.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import type { MemoryPackageFileSystem } from '../../support/evidence-package/memory-package-file-system.ts';
import { loadProbeCase } from '../../golden/transport-qualification/verdict/support/probe-golden.ts';
import { PROBE_IDENTITY, probePackage } from '../../golden/transport-qualification/verdict/support/probe-package.ts';
import type { ProbePackageVariation } from '../../golden/transport-qualification/verdict/support/probe-package.ts';
import { GOLDEN_IDENTITY, validationPackage } from '../../golden/variant-validation/support/validation-package.ts';
import { HARNESS_NOW, runCli } from './support/cli-harness.ts';
import { STORED_EVIDENCE_ROOT, packageOperand, storePackage } from './support/stored-packages.ts';

const validator = createRecordValidator();
const clock = new VirtualTimeScheduler({ wallEpochMs: Date.parse(HARNESS_NOW) });
const ROOT_FLAG = ['--evidence-root', STORED_EVIDENCE_ROOT];

async function storedProbe(variation: ProbePackageVariation = {}): Promise<MemoryPackageFileSystem> {
  const loaded = await loadProbeCase('ac021-probe-verdict-pass');
  return storePackage(PROBE_IDENTITY, probePackage(loaded.files, variation).files);
}

function probeCommand(fs: MemoryPackageFileSystem): ProbeVerifyCommand {
  return new ProbeVerifyCommand({ files: (): PackageFileSystem => fs, validator, clock });
}

function verificationPath(kind: VerificationKind, identity: ExecutionIdentity = PROBE_IDENTITY): string {
  return PACKAGE_LAYOUT.verificationPath(identity, HARNESS_NOW as UtcMillis, kind);
}

describe('probe verify', () => {
  it('completes for a usable probe and writes both outputs beside the package', async () => {
    const fs = await storedProbe();
    const run = await runCli(['probe', 'verify', packageOperand(PROBE_IDENTITY), ...ROOT_FLAG], [probeCommand(fs)]);
    assert.equal(run.exit_code, 0, JSON.stringify(run.result.reasons));
    assert.equal(run.result.transport_probe_id, PROBE_IDENTITY.transport_probe_id);
    assert.deepEqual(run.result.written_paths, [
      verificationPath('package-verification'),
      verificationPath('probe-usability-assessment'),
    ]);
    assert.equal(run.result.result_record?.['probe_usability'], 'usable');
    const stored = await fs.read(verificationPath('probe-usability-assessment'));
    assert.equal(stored.ok, true);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(stored.value)), run.result.result_record);
    assert.match(
      run.stderr_lines[0] ?? '',
      /^verifying \/operator\/evidence\/transport-probes\/\S+ with head none \(the original package\)$/,
    );
  });

  it('fails with the usability reasons for a probe that is not usable', async () => {
    const fs = await storedProbe({ late_evidence_status: 'contradictory' });
    const run = await runCli(['probe', 'verify', packageOperand(PROBE_IDENTITY), ...ROOT_FLAG], [probeCommand(fs)]);
    assert.equal(run.exit_code, 5);
    assert.deepEqual(
      run.result.reasons.map((reason) => reason.code),
      ['LATE_EVIDENCE_CONTRADICTORY'],
    );
    assert.equal(run.result.written_paths.length, 2);
  });

  it('verifies with an explicit head and names it in the progress line', async () => {
    const fs = await storedProbe();
    const head = 'f'.repeat(64);
    const run = await runCli(
      ['probe', 'verify', packageOperand(PROBE_IDENTITY), '--head', head, ...ROOT_FLAG],
      [probeCommand(fs)],
    );
    assert.equal(run.exit_code, 5);
    assert.ok(run.stderr_lines[0]?.endsWith(`with head ${head}`));
  });

  it('refuses a head that is not a digest, before reading anything', async () => {
    const fs = await storedProbe();
    const run = await runCli(
      ['probe', 'verify', packageOperand(PROBE_IDENTITY), '--head', 'ABC', ...ROOT_FLAG],
      [probeCommand(fs)],
    );
    assert.equal(run.exit_code, 2);
    assert.equal(
      run.result.reasons[0]?.detail,
      '--head "ABC" is not a digest; expected 64 lowercase hexadecimal characters',
    );
  });

  it('refuses a package of another kind', async () => {
    const fs = await storedProbe();
    const run = await runCli(['probe', 'verify', packageOperand(GOLDEN_IDENTITY), ...ROOT_FLAG], [probeCommand(fs)]);
    assert.equal(run.exit_code, 2);
    assert.match(
      run.result.reasons[0]?.detail ?? '',
      /is a VARIANT_VALIDATION package; expected a TRANSPORT_PROBE package$/,
    );
  });

  it('fails when the package cannot be listed', async () => {
    const fs = await storedProbe();
    fs.failLists(PACKAGE_LAYOUT.executionDirectory(PROBE_IDENTITY), 'IO_ERROR');
    const run = await runCli(['probe', 'verify', packageOperand(PROBE_IDENTITY), ...ROOT_FLAG], [probeCommand(fs)]);
    assert.equal(run.exit_code, 5);
    assert.equal(run.result.reasons[0]?.code, 'PACKAGE_UNREADABLE');
  });

  it('reports an output that already exists as an internal failure, keeping what it wrote', async () => {
    const fs = await storedProbe();
    assert.equal((await fs.writeOnce(verificationPath('probe-usability-assessment'), new Uint8Array([1]))).ok, true);
    const run = await runCli(['probe', 'verify', packageOperand(PROBE_IDENTITY), ...ROOT_FLAG], [probeCommand(fs)]);
    assert.equal(run.exit_code, 10);
    assert.deepEqual(run.result.written_paths, [verificationPath('package-verification')]);
    assert.equal(run.result.reasons[0]?.code, 'VERIFICATION_NOT_WRITTEN');
    assert.match(run.result.reasons[0].detail, /: ALREADY_EXISTS: /);
  });
});

describe('validation verify', () => {
  function command(fs: MemoryPackageFileSystem): ValidationVerifyCommand {
    return new ValidationVerifyCommand({ files: (): PackageFileSystem => fs, validator, clock });
  }

  it('completes for a verified validation and writes its verification', async () => {
    const fixture = validationPackage();
    const fs = await storePackage(GOLDEN_IDENTITY, fixture.files);
    const run = await runCli(['validation', 'verify', packageOperand(GOLDEN_IDENTITY), ...ROOT_FLAG], [command(fs)]);
    assert.equal(run.exit_code, 0, JSON.stringify(run.result.reasons));
    assert.equal(run.result.result_record?.['effective_implementation_validation_status'], 'verified');
    assert.deepEqual(run.result.written_paths, [verificationPath('variant-validation-verification', GOLDEN_IDENTITY)]);
  });

  it('fails with the effective status reasons when the validation is not verified', async () => {
    const fixture = validationPackage({ revision_check: 'failed' });
    const fs = await storePackage(GOLDEN_IDENTITY, fixture.files);
    const run = await runCli(['validation', 'verify', packageOperand(GOLDEN_IDENTITY), ...ROOT_FLAG], [command(fs)]);
    assert.equal(run.exit_code, 5);
    assert.notEqual(run.result.result_record?.['effective_implementation_validation_status'], 'verified');
    assert.ok(run.result.reasons.length > 0);
  });

  it('refuses a head that is not a digest', async () => {
    const fs = await storePackage(GOLDEN_IDENTITY, validationPackage().files);
    const run = await runCli(
      ['validation', 'verify', packageOperand(GOLDEN_IDENTITY), '--head', 'x', ...ROOT_FLAG],
      [command(fs)],
    );
    assert.equal(run.exit_code, 2);
  });

  it('fails without writing when the verifier cannot answer', async () => {
    const fixture = validationPackage();
    const fs = await storePackage(
      GOLDEN_IDENTITY,
      fixture.files.filter((file) => file.path !== 'summary/validation-summary.json'),
    );
    const run = await runCli(['validation', 'verify', packageOperand(GOLDEN_IDENTITY), ...ROOT_FLAG], [command(fs)]);
    assert.equal(run.exit_code, 5);
    assert.equal(run.result.variant_validation_id, executionIdOfGolden());
    assert.deepEqual(run.result.written_paths, []);
  });
});

function executionIdOfGolden(): string {
  return GOLDEN_IDENTITY.execution_kind === 'VARIANT_VALIDATION' ? GOLDEN_IDENTITY.variant_validation_id : '';
}

describe('verifiedReport', () => {
  it('reports the not-held reason when a no answer lists none', async () => {
    const fs = await storedProbe();
    const notHeldReason = notHeld('BR-RUA-026', 'the probe is not usable', 'a usable probe');
    const input = {
      identity: PROBE_IDENTITY,
      original: { files: [], special_entries: [] },
      amendments: [],
      selected_head: null,
      referenced_package_indexes: [],
      evaluated_at: HARNESS_NOW as UtcMillis,
    };
    const verification = verifyPackage(input, { validator, digest: sha256Hex });
    const report = await verifiedReport({ identity: PROBE_IDENTITY, files: fs, input }, HARNESS_NOW as UtcMillis, [], {
      holds: false,
      record: verification,
      reasons: [],
      notHeld: notHeldReason,
    });
    assert.deepEqual(report.reasons, [notHeldReason]);
    assert.deepEqual(notHeldReason, {
      code: 'VERIFICATION_NOT_HELD',
      subject: 'BR-RUA-026',
      detail: 'the probe is not usable; expected a usable probe',
    });
    assert.equal(report.outcome, 'verification_failed');
    assert.deepEqual(report.written_paths, []);
  });
});
