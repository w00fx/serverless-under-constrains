// The production composition (design §11 command table): every operator command is bound exactly
// once, the cloud-mutating ones require `--confirm-cloud-mutation`, and the AWS execution session
// factory builds a runner for an admitted package (no cloud call happens before the runner runs)
// or refuses a frozen coordination ARN that names no table. Nothing here reaches the cloud: the SDK
// clients are constructed but never sent a request.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAwsExecutionSessions } from '../../../src/operator-cli/aws/aws-execution-session.ts';
import { createCompositionRoot } from '../../../src/operator-cli/composition-root.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { goldenAdmitted } from '../../unit/operator-cli/support/golden-admitted.ts';

const STUDY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function root(): ReturnType<typeof createCompositionRoot> {
  return createCompositionRoot({
    studyRoot: STUDY_ROOT,
    cwd: '/operator',
    env: {},
    tempRoot: tmpdir(),
    nodeVersion: process.version,
    nodeExecutable: process.execPath,
  });
}

describe('composition root', () => {
  it('binds every design §11 command exactly once', () => {
    const words = root().commands.map((command) => command.spec.words.join(' '));
    assert.deepEqual(words.toSorted(), [
      'billing import',
      'coordination bootstrap',
      'coordination verify',
      'late-evidence assess',
      'oracle evaluate',
      'oracle revision-check',
      'probe admit',
      'probe execute',
      'probe verify',
      'recover',
      'run admit',
      'run execute',
      'run verify',
      'validation admit',
      'validation execute',
      'validation verify',
    ]);
  });

  it('requires the cloud-mutation confirmation on exactly the commands that mutate the cloud', () => {
    const confirmed = root()
      .commands.filter((command) => command.spec.flags.get('confirm-cloud-mutation') === 'required')
      .map((command) => command.spec.words.join(' '));
    assert.deepEqual(confirmed.toSorted(), [
      'coordination bootstrap',
      'probe execute',
      'recover',
      'run execute',
      'validation execute',
    ]);
  });

  it('resolves operand paths against the working directory', () => {
    assert.equal(root().resolvePath('evidence/runs/x'), '/operator/evidence/runs/x');
  });
});

describe('AWS execution sessions', () => {
  const sessions = createAwsExecutionSessions({
    studyRoot: STUDY_ROOT,
    nodeExecutable: process.execPath,
    env: {},
    validator: createRecordValidator(),
  });

  it('builds a runner for each admitted kind without calling the cloud', () => {
    for (const name of ['run', 'validation-conventional', 'probe'] as const) {
      const built = sessions(goldenAdmitted(name), tmpdir());
      assert.equal(built.ok, true, name);
      assert.equal(typeof built.value.abort, 'function');
    }
  });

  it('refuses a frozen coordination ARN that names no table', () => {
    const admitted = goldenAdmitted('run');
    const unnamed = {
      ...admitted,
      manifest: {
        ...admitted.manifest,
        environment: {
          ...admitted.manifest.environment,
          coordination_table_arn: 'arn:aws:dynamodb:us-east-1:012345678901:table/',
        },
      },
    };
    const built = sessions(unnamed, tmpdir());
    assert.equal(built.ok, false);
    assert.equal(built.error.code, 'COORDINATION_TABLE_UNNAMED');
  });
});
