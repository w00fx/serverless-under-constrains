// The coordination baseline commands (design §9.1, §10.1 A8, §11; BR-RUA-045): `bootstrap`
// deploys only under `--confirm-cloud-mutation coordination`, prints the stack outputs on stderr
// and exits 4 when the deploy did not complete; `verify --env <file>` runs step A8 on its own: 0
// when it passes, 7 on a conflicting holder, 5 on a configuration problem, 2 for an unreadable or
// invalid environment input.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CoordinationReadings } from '../../../src/admission/coordination-check.ts';
import { acquiredLeaseItem } from '../../../src/coordination-lease/lease-item.ts';
import { leaseOwnerOf } from '../../../src/coordination-lease/lease-store-port.ts';
import {
  CoordinationBootstrapCommand,
  CoordinationVerifyCommand,
} from '../../../src/operator-cli/coordination-commands.ts';
import { ok } from '../../../src/record-contract/primitives.ts';
import type { Sha256Hex, UtcMillis, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { CONFIGURED_TABLE, TABLE_ARN, environmentInput } from '../../support/admission/admission-fixtures.ts';
import { runCli } from './support/cli-harness.ts';
import { MemoryInputFileReader } from './support/memory-input-file-reader.ts';
import {
  COORDINATION_STACK,
  ScriptedCoordinationDeploy,
  coordinationReport,
} from './support/scripted-coordination-deploy.ts';
import { ScriptedCoordinationReader } from './support/scripted-coordination-reader.ts';

const validator = createRecordValidator();
const CLEAN: CoordinationReadings = { table: ok(CONFIGURED_TABLE), lease: ok(undefined) };
const ENV_PATH = '/operator/environment.json';

async function bootstrap(argv: readonly string[], fake = new ScriptedCoordinationDeploy()): ReturnType<typeof runCli> {
  return runCli(['coordination', 'bootstrap', ...argv], [new CoordinationBootstrapCommand(fake.deploy)]);
}

function verifyCommand(reader: ScriptedCoordinationReader, inputs: MemoryInputFileReader): CoordinationVerifyCommand {
  return new CoordinationVerifyCommand({ inputs, validator, read: reader.read });
}

function environmentFile(contents: string = JSON.stringify(environmentInput())): MemoryInputFileReader {
  return new MemoryInputFileReader().place(ENV_PATH, contents);
}

describe('coordination bootstrap', () => {
  it('deploys under the coordination confirmation and prints every stack output', async () => {
    const fake = new ScriptedCoordinationDeploy();
    const run = await bootstrap(['--confirm-cloud-mutation', 'coordination'], fake);
    assert.equal(run.exit_code, 0);
    assert.deepEqual(run.result.written_paths, []);
    assert.equal(fake.deploys(), 1);
    assert.deepEqual(run.stderr_lines, [
      'deploying the coordination baseline',
      `${COORDINATION_STACK} output CoordinationTableArn=arn:aws:dynamodb:us-east-1:012345678901:table/suc-study-1-coordination`,
    ]);
  });

  it('refuses any other confirmation before deploying', async () => {
    const fake = new ScriptedCoordinationDeploy();
    const run = await bootstrap(['--confirm-cloud-mutation', 'Coordination'], fake);
    assert.equal(run.exit_code, 2);
    assert.equal(fake.deploys(), 0);
    assert.equal(
      run.result.reasons[0]?.detail,
      '--confirm-cloud-mutation "Coordination" does not confirm "coordination"; expected --confirm-cloud-mutation coordination',
    );
  });

  it('exits 4 with the deployer reasons when the deploy did not complete', async () => {
    const reason = { code: 'CDK_DEPLOY_FAILED', subject: 'BR-RUA-045', detail: 'cdk exited 1' };
    const run = await bootstrap(
      ['--confirm-cloud-mutation', 'coordination'],
      new ScriptedCoordinationDeploy(coordinationReport({ deployed: false, outputs: [], reasons: [reason] })),
    );
    assert.equal(run.exit_code, 4);
    assert.equal(run.result.outcome, 'execution_incomplete');
    assert.deepEqual(run.result.reasons, [reason]);
  });

  it('still names why when an incomplete deploy gave no reason', async () => {
    const run = await bootstrap(
      ['--confirm-cloud-mutation', 'coordination'],
      new ScriptedCoordinationDeploy(coordinationReport({ deployed: false, outputs: [] })),
    );
    assert.equal(run.exit_code, 4);
    assert.deepEqual(run.result.reasons, [
      {
        code: 'COORDINATION_NOT_DEPLOYED',
        subject: 'BR-RUA-045',
        detail: `${COORDINATION_STACK} was not deployed and no reason was given; expected a deployed baseline`,
      },
    ]);
  });
});

describe('coordination verify', () => {
  it('completes when step A8 passes and reads the table the environment names', async () => {
    const reader = new ScriptedCoordinationReader(CLEAN);
    const run = await runCli(
      ['coordination', 'verify', '--env', 'environment.json'],
      [verifyCommand(reader, environmentFile())],
    );
    assert.equal(run.exit_code, 0, JSON.stringify(run.result.reasons));
    assert.deepEqual(run.result.reasons, []);
    assert.deepEqual(run.stderr_lines, [`verifying ${TABLE_ARN}`]);
    assert.equal(reader.reads[0]?.coordination_table_arn, TABLE_ARN);
  });

  it('exits 7 when a conflicting holder holds the lease', async () => {
    const owner = leaseOwnerOf(
      { execution_kind: 'RUN', run_id: '7d2c4b1a-9e8f-4a3b-8c2d-1e0f9a8b7c6d' as Uuid4 },
      'ab'.repeat(32) as Sha256Hex,
    );
    const held = acquiredLeaseItem(owner, '2026-01-01T00:00:00.000Z' as UtcMillis);
    const reader = new ScriptedCoordinationReader({ ...CLEAN, lease: ok(held) });
    const run = await runCli(['coordination', 'verify', '--env', ENV_PATH], [verifyCommand(reader, environmentFile())]);
    assert.equal(run.exit_code, 7);
    assert.equal(run.result.outcome, 'lease_problem');
  });

  it('exits 5 on a configuration problem', async () => {
    const reader = new ScriptedCoordinationReader({
      ...CLEAN,
      table: ok({ ...CONFIGURED_TABLE, deletion_protection_enabled: false }),
    });
    const run = await runCli(['coordination', 'verify', '--env', ENV_PATH], [verifyCommand(reader, environmentFile())]);
    assert.equal(run.exit_code, 5);
    assert.deepEqual(
      run.result.reasons.map((reason) => reason.detail),
      ['deletion protection is disabled; expected enabled'],
    );
  });

  it('is a usage error for an unreadable, malformed or invalid environment input, before any read', async () => {
    const cases: readonly (readonly [MemoryInputFileReader, string])[] = [
      [
        new MemoryInputFileReader(),
        `--env "${ENV_PATH}" cannot be read (ENOENT); expected a readable environment_input JSON file`,
      ],
      [
        environmentFile('{'),
        `--env "${ENV_PATH}" is not a valid environment_input; expected a readable environment_input JSON file`,
      ],
      [
        environmentFile(JSON.stringify(environmentInput({ record_type: 'other' }))),
        `--env "${ENV_PATH}" is not a valid environment_input; expected a readable environment_input JSON file`,
      ],
    ];
    for (const [inputs, detail] of cases) {
      const reader = new ScriptedCoordinationReader(CLEAN);
      const run = await runCli(['coordination', 'verify', '--env', ENV_PATH], [verifyCommand(reader, inputs)]);
      assert.equal(run.exit_code, 2);
      assert.deepEqual(
        run.result.reasons.map((reason) => reason.detail),
        [detail],
      );
      assert.deepEqual(reader.reads, []);
    }
  });
});
