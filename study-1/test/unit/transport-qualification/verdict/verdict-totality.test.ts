// The probe verdict and usability over hostile bytes (Owner amendment A-05): nesting deeper than
// any call stack, a number beyond binary64, and member names a prototype lookup would find, in the
// probe's evidence and in its stored package. Nothing throws; every hostile file is rejected.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { UtcMillis } from '../../../../src/record-contract/primitives.ts';
import { buildProbeResult } from '../../../../src/transport-qualification/verdict/probe-result.ts';
import { assessProbeUsability } from '../../../../src/transport-qualification/verdict/probe-usability.ts';
import { readProbeUsabilityInput } from '../../../../src/transport-qualification/verdict/probe-usability-reader.ts';
import { GOLDEN_VALIDATOR } from '../../../golden/transport-qualification/verdict/support/probe-golden.ts';
import { assertWellFormed } from '../../../golden/transport-qualification/verdict/support/verdict-assertions.ts';
import { packageInput, probePackage } from '../../../golden/transport-qualification/verdict/support/probe-package.ts';
import { DEEP_NESTING, towerText } from '../../../support/kernel/deep-json.ts';
import {
  hostileProbeEvidence,
  probeFiles,
  SUBJECT_FILES,
} from '../../treatment-fidelity/support/treatment-evidence.ts';

const DEPS = { validator: GOLDEN_VALIDATOR, digest: sha256Hex };
const CHECKED_AT = '2026-10-05T12:08:00.000Z' as UtcMillis;
const RESULT_PATH = PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'transportProbeResult');

/** The usability facts after replacing one stored file's bytes with `content`. */
function usabilityWith(path: string, content: string): ReturnType<typeof assessProbeUsability> {
  const pkg = probePackage(probeFiles());
  const files = pkg.files.map((file) =>
    file.path === path ? { path, bytes: new TextEncoder().encode(content) } : file,
  );
  return assessProbeUsability(readProbeUsabilityInput(packageInput({ ...pkg, files }), DEPS));
}

function storedText(path: string): string {
  const bytes = probePackage(probeFiles()).files.find((file) => file.path === path)?.bytes ?? new Uint8Array();
  return new TextDecoder().decode(bytes);
}

describe('the probe result over hostile evidence (A-05)', () => {
  it(`stays well formed when the runner journal holds ${String(DEEP_NESTING)} levels of nesting`, () => {
    const evidence = hostileProbeEvidence(
      SUBJECT_FILES.runner,
      (text) => `${text}${towerText('mixed', DEEP_NESTING, '1')}\n`,
    );
    const result = buildProbeResult({ evidence, checked_at: CHECKED_AT });
    assert.equal(result.ok, true);
    assertWellFormed(result.value);
    assert.notEqual(result.value.transport_probe_verdict, 'pass');
  });

  it('stays well formed when a provider sequence number is 1e400', () => {
    const evidence = hostileProbeEvidence(SUBJECT_FILES.provider, (text) =>
      text.replace('"source_sequence":2', '"source_sequence":1e400'),
    );
    const result = buildProbeResult({ evidence, checked_at: CHECKED_AT });
    assert.equal(result.ok, true);
    assertWellFormed(result.value);
    assert.notEqual(result.value.transport_probe_verdict, 'pass');
  });

  it('never counts an invocation from inherited member names', () => {
    const evidence = hostileProbeEvidence(
      SUBJECT_FILES.caller,
      (text) =>
        `${text}{"__proto__":{"record_type":"caller_invocation_started"},"constructor":{"source":"probe_caller"}}\n`,
    );
    const result = buildProbeResult({ evidence, checked_at: CHECKED_AT });
    assert.equal(result.ok, true);
    assertWellFormed(result.value);
    assert.equal(result.value.probe_cardinality.caller_invocations, 1);
  });
});

describe('probe usability over hostile package bytes (A-05)', () => {
  it(`reads a summary of ${String(DEEP_NESTING)} levels of nesting as no summary`, () => {
    const assessment = usabilityWith(EXECUTION_PATHS.transportProbeSummary, towerText('object', DEEP_NESTING, '1'));
    assert.equal(assessment.probe_usability, 'not_usable');
    assert.equal(assessment.transport_probe_verdict, 'indeterminate');
    assert.equal(assessment.late_evidence_status, 'unverified');
  });

  it('reads a frozen result holding 1e400 as no result', () => {
    const hostile = storedText(RESULT_PATH).replace('"schema_version":1', '"schema_version":1e400');
    const assessment = usabilityWith(RESULT_PATH, hostile);
    assert.equal(assessment.probe_usability, 'not_usable');
    assert.equal(assessment.transport_probe_verdict, 'indeterminate');
  });

  it('never reads a scope snapshot or index entry from inherited member names', () => {
    const index = storedText(EXECUTION_PATHS.packageIndex).replace(
      '"entries":',
      '"__proto__":{"entries":[]},"entries":',
    );
    const assessment = usabilityWith(EXECUTION_PATHS.packageIndex, index);
    assert.equal(assessment.probe_usability, 'not_usable');
    assert.ok(assessment.reasons.some((reason) => reason.code === 'NO_TRANSPORT_SCOPE_SNAPSHOT'));
  });
});
