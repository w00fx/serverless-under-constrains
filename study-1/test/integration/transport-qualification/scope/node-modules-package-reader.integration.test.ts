// NodeModulesPackageReader over a real directory tree (BR-RUA-028 "the scope it actually
// exercised"): only a missing manifest reads as "not installed"; a malformed, versionless or
// unreadable manifest rejects with the offending value and the expected shape, so it can never
// pass for an absent package. Manifests are untrusted input (A-05): non-finite numbers and
// inherited member names are refused, never thrown on.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { NodeModulesPackageReader } from '../../../../src/transport-qualification/scope/node/node-modules-package-reader.ts';
import { TemporaryScopeProject } from './support/temporary-scope-project.ts';

describe('NodeModulesPackageReader', () => {
  let project: TemporaryScopeProject;
  let reader: NodeModulesPackageReader;

  before(() => {
    project = TemporaryScopeProject.create({});
    project.installPackage('ok-dep', '3.2.1', 'export {};\n');
    project.write('node_modules/malformed/package.json', '{"version":');
    project.write('node_modules/numeric/package.json', '{"version":1}');
    project.write('node_modules/infinite/package.json', '{"version":1e400}');
    project.write('node_modules/listed/package.json', '["1.0.0"]');
    project.write('node_modules/inherited/package.json', '{"__proto__":{"version":"1.0.0"}}');
    mkdirSync(join(project.projectRoot, 'node_modules/directory/package.json'), { recursive: true });
    reader = new NodeModulesPackageReader({ projectRoot: project.projectRoot });
  });

  after(() => {
    project.dispose();
  });

  it('reads the version of an installed manifest', async () => {
    assert.equal(await reader.installedVersion('node_modules/ok-dep'), '3.2.1');
  });

  it('reads a missing manifest, a missing directory and a path through a file as not installed', async () => {
    assert.equal(await reader.installedVersion('node_modules/absent'), undefined);
    assert.equal(await reader.installedVersion('node_modules/ok-dep/index.js'), undefined);
    const rootless = new NodeModulesPackageReader({ projectRoot: join(project.projectRoot, 'missing-root') });
    assert.equal(await rootless.installedVersion('node_modules/ok-dep'), undefined);
  });

  it('rejects a manifest that is not one JSON document, a non-finite number included', async () => {
    for (const name of ['malformed', 'infinite']) {
      await assert.rejects(reader.installedVersion(`node_modules/${name}`), {
        message: `node_modules/${name}/package.json is not one JSON document (invalid_json); expected a package manifest`,
      });
    }
  });

  it('rejects a manifest without an own string version', async () => {
    const cases = [
      ['numeric', 'number 1'],
      ['listed', 'absent'],
      ['inherited', 'absent'],
    ] as const;
    for (const [name, found] of cases) {
      await assert.rejects(reader.installedVersion(`node_modules/${name}`), {
        message: `node_modules/${name}/package.json has version ${found}; expected a string`,
      });
    }
  });

  it('rejects an unreadable manifest with the file system error', async () => {
    await assert.rejects(
      reader.installedVersion('node_modules/directory'),
      /^Error: node_modules\/directory\/package\.json cannot be read: EISDIR: .+; expected a readable package manifest$/,
    );
  });
});
