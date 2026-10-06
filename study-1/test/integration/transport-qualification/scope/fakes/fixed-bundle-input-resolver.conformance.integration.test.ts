// Conformance of FixedBundleInputResolver with EsbuildBundleInputResolver (RK-17): seeded
// with the closures esbuild computes, it answers the same requests identically, in request
// order, reports the same bundling runtime properties, and both reject an entry point they
// cannot resolve with esbuild's wording.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { BundleInputResolver } from '../../../../../src/transport-qualification/scope/bundle-inputs.ts';
import { EsbuildBundleInputResolver } from '../../../../../src/transport-qualification/scope/node/esbuild-bundle-input-resolver.ts';
import { FixedBundleInputResolver } from '../../../../unit/transport-qualification/scope/support/fixed-bundle-input-resolver.ts';
import {
  ORACLE_SOURCE,
  PROBE_HANDLER,
  PROVIDER_HANDLER,
} from '../../../../unit/transport-qualification/scope/support/scope-fixtures.ts';
import { PROJECT_FILES, installProjectPackages } from '../support/scope-project-files.ts';
import { TemporaryScopeProject } from '../support/temporary-scope-project.ts';

const ABSENT = 'src/absent.handler.ts';

describe('FixedBundleInputResolver conformance with EsbuildBundleInputResolver', () => {
  let project: TemporaryScopeProject;
  let esbuild: BundleInputResolver;
  let fixed: FixedBundleInputResolver;

  before(async () => {
    project = TemporaryScopeProject.create(PROJECT_FILES);
    installProjectPackages(project);
    esbuild = new EsbuildBundleInputResolver({ projectRoot: project.projectRoot });
    fixed = new FixedBundleInputResolver(await esbuild.resolve([PROBE_HANDLER, PROVIDER_HANDLER, ORACLE_SOURCE]));
  });

  after(() => {
    project.dispose();
  });

  for (const request of [[PROVIDER_HANDLER, PROBE_HANDLER], [ORACLE_SOURCE], []]) {
    it(`answers ${JSON.stringify(request)} identically, in request order`, async () => {
      assert.deepEqual(await fixed.resolve(request), await esbuild.resolve(request));
    });
  }

  it('reports the same bundling runtime properties by default', () => {
    assert.deepEqual(fixed.runtime_properties, esbuild.runtime_properties);
  });

  it('rejects an unresolvable entry point the same way', async () => {
    const pattern = /Could not resolve "src\/absent\.handler\.ts"/;
    await assert.rejects(esbuild.resolve([PROBE_HANDLER, ABSENT]), pattern);
    await assert.rejects(fixed.resolve([PROBE_HANDLER, ABSENT]), pattern);
  });
});

describe('FixedBundleInputResolver controls', () => {
  it('records requests and scripts Error and non-Error failures', async () => {
    const resolver = new FixedBundleInputResolver();
    assert.deepEqual(await resolver.resolve([]), []);
    resolver.failWith('bundler crashed');
    await assert.rejects(
      resolver.resolve(['a.ts']),
      (error: unknown) => error instanceof Error && error.message === 'bundler crashed',
    );
    resolver.failWithNonError('plain');
    await assert.rejects(resolver.resolve(['b.ts']), (error: unknown) => error === 'plain');
    assert.deepEqual(resolver.requests(), [[], ['a.ts'], ['b.ts']]);
  });

  it('reports preset runtime properties', () => {
    assert.deepEqual(new FixedBundleInputResolver([], { bundle_format: 'cjs' }).runtime_properties, {
      bundle_format: 'cjs',
    });
  });
});
