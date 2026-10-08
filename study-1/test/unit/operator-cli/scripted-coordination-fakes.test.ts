// Conformance of the coordination fakes the command tests use: the scripted deploy report keeps the
// real deployer's `DeployReport` invariants (deployed exactly when no reason is given, outputs
// sorted by key, completion after start), and the scripted readings of the configured table with
// no lease item are what step A8 admits.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessCoordination } from '../../../src/admission/coordination-check.ts';
import { ok } from '../../../src/record-contract/primitives.ts';
import type { EnvironmentInput } from '../../../src/record-contract/records/group-a/environment_input.ts';
import { CONFIGURED_TABLE, environmentInput } from '../../support/admission/admission-fixtures.ts';
import {
  COORDINATION_STACK,
  ScriptedCoordinationDeploy,
  coordinationReport,
} from './support/scripted-coordination-deploy.ts';
import { ScriptedCoordinationReader } from './support/scripted-coordination-reader.ts';

describe('coordination fakes', () => {
  it('reports a deploy with the deployer invariants and counts each deploy', async () => {
    const fake = new ScriptedCoordinationDeploy();
    const report = await fake.deploy();
    assert.equal(fake.deploys(), 1);
    assert.equal(report.stack_name, COORDINATION_STACK);
    assert.equal(report.deployed, report.reasons.length === 0);
    assert.ok(Date.parse(report.completed_at) > Date.parse(report.started_at));
    const keys = report.outputs.map((output) => output.key);
    assert.deepEqual(keys, keys.toSorted());
    const failed = coordinationReport({ deployed: false, outputs: [] });
    assert.deepEqual(failed.outputs, []);
  });

  it('answers readings step A8 admits for the configured table, recording the environment', async () => {
    const environment = environmentInput() as unknown as EnvironmentInput;
    const reader = new ScriptedCoordinationReader({ table: ok(CONFIGURED_TABLE), lease: ok(undefined) });
    const readings = await reader.read(environment);
    assert.equal(assessCoordination(readings, environment).passed, true);
    assert.deepEqual(reader.reads, [environment]);
  });
});
