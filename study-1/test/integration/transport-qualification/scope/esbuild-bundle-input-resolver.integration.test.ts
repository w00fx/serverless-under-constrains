// The esbuild adapter yields each entry point's transitive production closure from the real
// metafile (design CF V-1 / RF V2), bundling the way `ObservableFunction` deploys.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { SCOPE_BUNDLE_RUNTIME_PROPERTIES } from '../../../../src/transport-qualification/scope/bundle-inputs.ts';
import { EsbuildBundleInputResolver } from '../../../../src/transport-qualification/scope/node/esbuild-bundle-input-resolver.ts';
import {
  CLIENT_SOURCE,
  ORACLE_SOURCE,
  PROBE_HANDLER,
  PROVIDER_HANDLER,
  SHARED_PRIMITIVES,
} from '../../../unit/transport-qualification/scope/support/scope-fixtures.ts';
import { PROJECT_FILES, installProjectPackages } from './support/scope-project-files.ts';
import { TemporaryScopeProject } from './support/temporary-scope-project.ts';

describe('EsbuildBundleInputResolver', () => {
  let project: TemporaryScopeProject;

  before(() => {
    project = TemporaryScopeProject.create(PROJECT_FILES);
    installProjectPackages(project);
    // A nested install and a scoped package reached only through transport-dep.
    project.installPackage('transport-dep/node_modules/nested-dep', '3.0.0', "export const nested = 'n';\n");
    project.installPackage('@scope/helper', '1.2.0', "export const helper = 'h';\n");
    project.write(
      'node_modules/transport-dep/index.js',
      "import { nested } from 'nested-dep';\nimport { helper } from '@scope/helper';\nexport const transportDep = nested + helper;\n",
    );
  });

  after(() => {
    project.dispose();
  });

  it('returns each entry point closure in request order, with project sources and install paths', async () => {
    const resolver = new EsbuildBundleInputResolver({ projectRoot: project.projectRoot });
    assert.deepEqual(await resolver.resolve([PROBE_HANDLER, PROVIDER_HANDLER]), [
      {
        entry_point: PROBE_HANDLER,
        local_sources: [CLIENT_SOURCE, SHARED_PRIMITIVES, PROBE_HANDLER],
        packages: [
          'node_modules/@scope/helper',
          'node_modules/transport-dep',
          'node_modules/transport-dep/node_modules/nested-dep',
        ],
      },
      { entry_point: PROVIDER_HANDLER, local_sources: [SHARED_PRIMITIVES, PROVIDER_HANDLER], packages: [] },
    ]);
  });

  it('keeps modules the entry point never imports out of its closure', async () => {
    const resolver = new EsbuildBundleInputResolver({ projectRoot: project.projectRoot });
    const [oracle] = await resolver.resolve([ORACLE_SOURCE]);
    const [probe] = await resolver.resolve([PROBE_HANDLER]);
    assert.ok(oracle !== undefined && probe !== undefined);
    assert.deepEqual(oracle.packages, ['node_modules/reporting-dep']);
    assert.equal(probe.local_sources.includes(ORACLE_SOURCE), false);
    assert.equal(probe.packages.includes('node_modules/reporting-dep'), false);
  });

  it('rejects an entry point or import that cannot be resolved', async () => {
    const resolver = new EsbuildBundleInputResolver({ projectRoot: project.projectRoot });
    await assert.rejects(resolver.resolve(['src/absent.handler.ts']), /Could not resolve "src\/absent\.handler\.ts"/);
  });

  it('resolves nothing for an empty request', async () => {
    const resolver = new EsbuildBundleInputResolver({ projectRoot: project.projectRoot });
    assert.deepEqual(await resolver.resolve([]), []);
  });

  it('reports the bundling options it resolves with as runtime properties', () => {
    const resolver = new EsbuildBundleInputResolver({ projectRoot: project.projectRoot });
    assert.deepEqual(resolver.runtime_properties, {
      bundle_aws_sdk: true,
      bundle_format: 'esm',
      bundle_main_fields: 'module,main',
      bundle_platform: 'node',
      bundle_target: 'node24',
    });
  });

  it('binds the bundling options ObservableFunction deploys with', () => {
    const construct = readFileSync(
      new URL('../../../../infra/constructs/observable-function.ts', import.meta.url),
      'utf8',
    );
    assert.equal(SCOPE_BUNDLE_RUNTIME_PROPERTIES.bundle_format, 'esm');
    assert.match(construct, /format: OutputFormat\.ESM,/);
    assert.equal(SCOPE_BUNDLE_RUNTIME_PROPERTIES.bundle_main_fields, 'module,main');
    assert.match(construct, /mainFields: \['module', 'main'\],/);
    assert.equal(SCOPE_BUNDLE_RUNTIME_PROPERTIES.bundle_target, 'node24');
    assert.match(construct, /target: 'node24',/);
    assert.equal(SCOPE_BUNDLE_RUNTIME_PROPERTIES.bundle_aws_sdk, true);
    assert.match(construct, /bundleAwsSDK: true,/);
    assert.equal(SCOPE_BUNDLE_RUNTIME_PROPERTIES.bundle_platform, 'node');
    assert.doesNotMatch(construct, /externalModules|nodeModules:/);
  });
});
