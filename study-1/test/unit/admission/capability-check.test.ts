// Step A6 (SAFETY; BR-RUA-053, RK-08): Node >=24.12 <25, a local esbuild 0.x, a consistent
// dependency tree, a usable CDKToolkit stack and enough unreserved concurrency for every deployed
// function; any failed read is a safety rejection.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  USABLE_BOOTSTRAP_STATUSES,
  assessCapabilities,
  supportedNodeVersion,
} from '../../../src/admission/capability-check.ts';
import type { CapabilityReadings } from '../../../src/admission/capability-check.ts';
import { err, ok } from '../../../src/record-contract/primitives.ts';
import { SUPPORTED_TOOLCHAIN } from '../../support/admission/admission-fixtures.ts';

const READINGS: CapabilityReadings = {
  toolchain: ok(SUPPORTED_TOOLCHAIN),
  unreserved_concurrency: ok(1000),
  bootstrap_status: ok('UPDATE_COMPLETE'),
  required_concurrency: 4,
};

function codes(overrides: Partial<CapabilityReadings>): readonly string[] {
  const verdict = assessCapabilities({ ...READINGS, ...overrides });
  return verdict.passed ? [] : verdict.reasons.map((reason) => reason.code);
}

describe('supportedNodeVersion', () => {
  it('accepts 24.12 and later 24.x only', () => {
    assert.deepEqual(
      ['v24.12.0', 'v24.15.0', 'v24.11.9', 'v25.0.0', 'v23.99.0', '24.15.0', 'v24.15', 'v24.15.0-rc.1'].map(
        supportedNodeVersion,
      ),
      [true, true, false, false, false, false, false, false],
    );
  });
});

describe('assessCapabilities (A6)', () => {
  it('admits a supported toolchain and records its versions', () => {
    const verdict = assessCapabilities(READINGS);
    assert.ok(verdict.passed);
    assert.deepEqual(verdict.value, {
      tool_versions: { node: 'v24.15.0', npm: '11.6.2', esbuild: '0.25.10', aws_cdk_cli: '2.1144.0' },
      unreserved_concurrency: 1000,
    });
    assert.deepEqual(verdict.statement.observed, {
      node: 'v24.15.0',
      esbuild: '0.25.10',
      unreserved_concurrency: 1000,
    });
  });

  it('records only versions that are nonempty trimmed strings', () => {
    const { npm_version: _npm, ...withoutNpm } = SUPPORTED_TOOLCHAIN;
    const verdict = assessCapabilities({ ...READINGS, toolchain: ok({ ...withoutNpm, aws_cdk_cli_version: ' 2.1 ' }) });
    assert.ok(verdict.passed);
    assert.deepEqual(verdict.value.tool_versions, { node: 'v24.15.0', esbuild: '0.25.10' });
  });

  it('refuses an unsupported Node, a missing or wrong esbuild and an inconsistent tree', () => {
    assert.deepEqual(
      codes({
        toolchain: ok({
          ...SUPPORTED_TOOLCHAIN,
          node_version: 'v22.11.0',
          esbuild_version: '1.0.0',
          dependency_tree_consistent: false,
          dependency_tree_detail: 'npm ls exited 1: missing esbuild',
        }),
      }),
      ['NODE_VERSION_UNSUPPORTED', 'ESBUILD_UNAVAILABLE', 'DEPENDENCY_TREE_INCONSISTENT'],
    );
    const { esbuild_version: _esbuild, ...withoutEsbuild } = SUPPORTED_TOOLCHAIN;
    const verdict = assessCapabilities({ ...READINGS, toolchain: ok(withoutEsbuild) });
    assert.ok(!verdict.passed);
    assert.match(verdict.reasons[0].detail, /^local esbuild is absent; expected an installed 0.x version$/);
    assert.deepEqual(verdict.statement.observed, { node: 'v24.15.0', esbuild: 'absent', unreserved_concurrency: 1000 });
  });

  it('refuses unreadable toolchain, account settings and bootstrap', () => {
    const failure = { code: 'EACCES', detail: 'denied' };
    const verdict = assessCapabilities({
      ...READINGS,
      toolchain: err(failure),
      unreserved_concurrency: err(failure),
      bootstrap_status: err(failure),
    });
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'SAFETY');
    assert.deepEqual(
      verdict.reasons.map((reason) => reason.code),
      ['TOOLCHAIN_UNREADABLE', 'ACCOUNT_SETTINGS_UNREADABLE', 'BOOTSTRAP_UNREADABLE'],
    );
    assert.deepEqual(verdict.statement.observed, { node: 'unread', esbuild: 'absent', unreserved_concurrency: -1 });
  });

  it('refuses concurrency below the deployed function count or not an integer', () => {
    assert.deepEqual(codes({ unreserved_concurrency: ok(3) }), ['UNRESERVED_CONCURRENCY_LOW']);
    assert.deepEqual(codes({ unreserved_concurrency: ok(4) }), []);
    assert.deepEqual(codes({ unreserved_concurrency: ok(4.5) }), ['UNRESERVED_CONCURRENCY_LOW']);
    const verdict = assessCapabilities({ ...READINGS, unreserved_concurrency: ok(3) });
    assert.ok(!verdict.passed);
    assert.equal(
      verdict.reasons[0].detail,
      'UnreservedConcurrentExecutions is 3; expected an integer of at least 4, one per deployed function',
    );
  });

  it('refuses a missing or unusable bootstrap stack and accepts every usable status', () => {
    assert.deepEqual(codes({ bootstrap_status: ok(undefined) }), ['BOOTSTRAP_MISSING']);
    assert.deepEqual(codes({ bootstrap_status: ok('ROLLBACK_COMPLETE') }), ['BOOTSTRAP_MISSING']);
    for (const status of USABLE_BOOTSTRAP_STATUSES) {
      assert.deepEqual(codes({ bootstrap_status: ok(status) }), [], status);
    }
  });
});
