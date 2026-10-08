// Step A13 (BR-RUA-028): the transport scope is recomputed from committed source and the
// synthesized template; a run or a validation must reproduce its selected probe's snapshot.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OR_RUA_002_TIMING, PROVIDER_WARMUP_POLICY, scopeTimingOf } from '../../../src/admission/declared-inputs.ts';
import { assessTransportScope } from '../../../src/admission/scope-check.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { ScopeEnvironment } from '../../../src/transport-qualification/scope/scope-recomputation.ts';
import { harnessId } from '../../support/admission/admission-harness.ts';
import { synthTemplate } from '../../support/admission/synth-templates.ts';
import { FixedBundleInputResolver } from '../transport-qualification/scope/support/fixed-bundle-input-resolver.ts';
import { MemoryCommittedSourceReader } from '../transport-qualification/scope/support/memory-committed-source-reader.ts';
import { MemoryInstalledPackageReader } from '../transport-qualification/scope/support/memory-installed-package-reader.ts';

const ENVIRONMENT: ScopeEnvironment = {
  template: synthTemplate('TRANSPORT_PROBE', harnessId(2)),
  runtime: {},
  timing: scopeTimingOf(OR_RUA_002_TIMING),
  provider_warmup: PROVIDER_WARMUP_POLICY,
};

describe('assessTransportScope (A13)', () => {
  it('rejects as QUALIFICATION when the snapshot cannot be recomputed', async () => {
    const ports = {
      sources: new MemoryCommittedSourceReader({}),
      bundles: new FixedBundleInputResolver([]),
      installed: new MemoryInstalledPackageReader({}),
      validator: createRecordValidator(),
    };
    const verdict = await assessTransportScope(ENVIRONMENT, ports, null);
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'QUALIFICATION');
    assert.equal(verdict.statement.expected, 'recomputable_snapshot');
    assert.ok(verdict.reasons.length > 0);
  });
});
