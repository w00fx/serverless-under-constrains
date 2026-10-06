// The miniature transport project the integration tests commit into a temporary repository:
// a probe-caller and a provider entry point sharing a record-contract module, a provider
// client that bundles an npm package, an unimported file under a source root, and an oracle
// module plus a reporting package that the transport never reaches.

import type { TransportScopePolicy } from '../../../../../src/record-contract/records/group-a/transport_scope_policy.ts';
import { PACKAGE_LOCK_PATH } from '../../../../../src/transport-qualification/scope/package-lock.ts';
import { TRANSPORT_SCOPE_POLICY_PATH } from '../../../../../src/transport-qualification/scope/scope-policy.ts';
import {
  CLIENT_SOURCE,
  CLIENT_TIMING_FILE,
  ORACLE_SOURCE,
  PROBE_HANDLER,
  PROVIDER_HANDLER,
  SAMPLE_POLICY,
  SHARED_PRIMITIVES,
  lockEntry,
  lockfileJson,
} from '../../../../unit/transport-qualification/scope/support/scope-fixtures.ts';
import type { LockEntryFixture } from '../../../../unit/transport-qualification/scope/support/scope-fixtures.ts';
import type { TemporaryScopeProject } from './temporary-scope-project.ts';

export const PROJECT_POLICY: TransportScopePolicy = {
  ...SAMPLE_POLICY,
  runtime_properties: ['bundle_aws_sdk', 'bundle_format', 'bundle_main_fields', 'bundle_platform', 'bundle_target'],
};

export function projectLock(transportVersion: string, reportingVersion = '7.0.0'): string {
  const entries: Record<string, LockEntryFixture> = {
    'node_modules/transport-dep': lockEntry('transport-dep', transportVersion),
    'node_modules/@scope/declared-dep': lockEntry('@scope/declared-dep', '4.1.0'),
    'node_modules/reporting-dep': lockEntry('reporting-dep', reportingVersion),
  };
  return lockfileJson(entries);
}

export const PROJECT_FILES: Readonly<Record<string, string>> = {
  '.gitignore': 'node_modules/\n',
  'package.json': `${JSON.stringify({ name: 'scope-fixture', private: true, type: 'module' })}\n`,
  [PACKAGE_LOCK_PATH]: projectLock('1.0.0'),
  [TRANSPORT_SCOPE_POLICY_PATH]: `${JSON.stringify(PROJECT_POLICY, null, 2)}\n`,
  [SHARED_PRIMITIVES]: "export const SHARED_MARKER = 'shared';\n",
  [CLIENT_SOURCE]: [
    "import { transportDep } from 'transport-dep';",
    "import { SHARED_MARKER } from '../record-contract/primitives.ts';",
    'export const client = `${transportDep}:${SHARED_MARKER}`;',
    '',
  ].join('\n'),
  [CLIENT_TIMING_FILE]: '{"deadline_ms":3000}\n',
  [PROBE_HANDLER]: [
    "import { client } from '../provider-client/provider-client.ts';",
    'export const handler = (): string => client;',
    '',
  ].join('\n'),
  [PROVIDER_HANDLER]: [
    "import { SHARED_MARKER } from '../record-contract/primitives.ts';",
    'export const handler = (): string => SHARED_MARKER;',
    '',
  ].join('\n'),
  [ORACLE_SOURCE]: [
    "import { reportingDep } from 'reporting-dep';",
    "import { SHARED_MARKER } from '../record-contract/primitives.ts';",
    'export const oracle = `${reportingDep}:${SHARED_MARKER}:v1`;',
    '',
  ].join('\n'),
};

/** Installs the packages the lockfile of `projectLock(transportVersion)` records. */
export function installProjectPackages(project: TemporaryScopeProject, transportVersion = '1.0.0'): void {
  project.installPackage('transport-dep', transportVersion, `export const transportDep = '${transportVersion}';\n`);
  project.installPackage('@scope/declared-dep', '4.1.0', "export const declaredDep = 'declared';\n");
  project.installPackage('reporting-dep', '7.0.0', "export const reportingDep = 'reporting';\n");
}
