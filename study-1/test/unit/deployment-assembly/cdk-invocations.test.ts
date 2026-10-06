// The exact CDK CLI command lines (design §9.8 S1, D2; RK-11, CF V-10): the pinned CLI under the
// explicit Node executable, the Docker sentinel, no telemetry or notices; synthesis isolated from
// every AWS credential source with a quotable Node path, deployment with the operator environment.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ABSENT_AWS_CONFIG_FILE,
  cdkDeployInvocation,
  cdkSynthInvocation,
  EXECUTION_CONTEXT_FILE,
  STUDY_APP_ENTRY,
  SYNTH_OUTPUT_DIR,
} from '../../../src/deployment-assembly/cdk-invocations.ts';
import {
  commandSucceeded,
  describeCommandResult,
  STDERR_TAIL_CHARACTERS,
} from '../../../src/deployment-assembly/command-outcome.ts';
import { MEMORY_TOOLS, RUN_STACK } from '../../support/deployment-assembly/deployment-fixtures.ts';

describe('cdkSynthInvocation (S1)', () => {
  it('runs the pinned CLI on the study app into the staging directory, with lookups off', () => {
    const invocation = cdkSynthInvocation(MEMORY_TOOLS, '/attempt/staging', RUN_STACK);
    assert.ok(invocation.ok);
    assert.equal(invocation.value.executable, '/opt/node24/bin/node');
    assert.deepEqual(invocation.value.args, [
      '/study/node_modules/aws-cdk/bin/cdk',
      'synth',
      RUN_STACK,
      '--app',
      `"/opt/node24/bin/node" ${STUDY_APP_ENTRY}`,
      '--output',
      `/attempt/staging/${SYNTH_OUTPUT_DIR}`,
      '--context',
      `suc:execution=/attempt/staging/${EXECUTION_CONTEXT_FILE}`,
      '--no-lookups',
      '--path-metadata',
      '--no-version-reporting',
      '--no-notices',
      '--quiet',
    ]);
    assert.equal(invocation.value.cwd, '/study');
  });

  it('drops every AWS variable and points the AWS config files at an absent path', () => {
    const invocation = cdkSynthInvocation(MEMORY_TOOLS, '/attempt/staging', RUN_STACK);
    assert.ok(invocation.ok);
    assert.deepEqual(invocation.value.env, {
      PATH: '/usr/bin',
      HOME: '/home/operator',
      CDK_DOCKER: '/study/tools/docker-forbidden.sh',
      CDK_DISABLE_CLI_TELEMETRY: 'true',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_CONFIG_FILE: `/attempt/staging/${ABSENT_AWS_CONFIG_FILE}`,
      AWS_SHARED_CREDENTIALS_FILE: `/attempt/staging/${ABSENT_AWS_CONFIG_FILE}`,
    });
  });

  it('refuses a Node path a shell would interpret inside the --app quotes', () => {
    for (const path of ['/opt/no"de', '/opt/$HOME/node', '/opt/`x`/node', '/opt/a\\b', '/opt/a\nb', '/opt/a\rb']) {
      const invocation = cdkSynthInvocation({ ...MEMORY_TOOLS, node_executable: path }, '/s', RUN_STACK);
      assert.equal(invocation.ok ? 'ok' : invocation.error.code, 'UNQUOTABLE_NODE_PATH', JSON.stringify(path));
      assert.equal(invocation.ok ? '' : invocation.error.subject, 'BR-RUA-042');
    }
    assert.equal(
      cdkSynthInvocation({ ...MEMORY_TOOLS, node_executable: "/opt/it's node/bin/node" }, '/s', RUN_STACK).ok,
      true,
    );
  });
});

describe('cdkDeployInvocation (D2)', () => {
  it('deploys exactly the one stack from the copy, without approval prompts, writing the outputs file', () => {
    const invocation = cdkDeployInvocation(MEMORY_TOOLS, '/study/.deploy-staging/x', RUN_STACK, '/work/outputs.json');
    assert.deepEqual(invocation, {
      executable: '/opt/node24/bin/node',
      args: [
        '/study/node_modules/aws-cdk/bin/cdk',
        'deploy',
        RUN_STACK,
        '--app',
        '/study/.deploy-staging/x',
        '--exclusively',
        '--require-approval',
        'never',
        '--outputs-file',
        '/work/outputs.json',
        '--no-version-reporting',
        '--no-notices',
      ],
      cwd: '/study',
      env: {
        PATH: '/usr/bin',
        HOME: '/home/operator',
        AWS_PROFILE: 'operator',
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        AWS_REGION: 'us-east-1',
        CDK_DOCKER: '/study/tools/docker-forbidden.sh',
        CDK_DISABLE_CLI_TELEMETRY: 'true',
      },
    });
  });

  it('lets the tool variables win over an operator value', () => {
    const tools = { ...MEMORY_TOOLS, environment: { CDK_DOCKER: 'docker', CDK_DISABLE_CLI_TELEMETRY: 'false' } };
    const deploy = cdkDeployInvocation(tools, '/c', RUN_STACK, '/o.json');
    const synth = cdkSynthInvocation(tools, '/s', RUN_STACK);
    assert.equal(deploy.env['CDK_DOCKER'], '/study/tools/docker-forbidden.sh');
    assert.equal(synth.ok ? synth.value.env['CDK_DISABLE_CLI_TELEMETRY'] : '', 'true');
  });
});

describe('command outcome', () => {
  it('succeeds only on exit status 0', () => {
    assert.equal(commandSucceeded({ kind: 'exited', exit_code: 0, stdout: '', stderr: '' }), true);
    assert.equal(commandSucceeded({ kind: 'exited', exit_code: 1, stdout: '', stderr: '' }), false);
    assert.equal(commandSucceeded({ kind: 'signalled', signal: 'SIGTERM', stdout: '', stderr: '' }), false);
    assert.equal(commandSucceeded({ kind: 'spawn_failed', detail: 'ENOENT' }), false);
  });

  it('describes each ending with the bounded tail of stderr', () => {
    assert.equal(
      describeCommandResult({ kind: 'exited', exit_code: 2, stdout: 'ignored', stderr: 'boom' }),
      'exited with status 2; stderr tail: boom',
    );
    assert.equal(
      describeCommandResult({ kind: 'signalled', signal: 'SIGKILL', stdout: '', stderr: '' }),
      'ended by signal SIGKILL; stderr tail: ',
    );
    assert.equal(
      describeCommandResult({ kind: 'spawn_failed', detail: 'node: ENOENT' }),
      'could not start: node: ENOENT',
    );
    const long = `${'x'.repeat(10_000)}${'y'.repeat(STDERR_TAIL_CHARACTERS)}`;
    const described = describeCommandResult({ kind: 'exited', exit_code: 1, stdout: '', stderr: long });
    assert.equal(described, `exited with status 1; stderr tail: ${'y'.repeat(STDERR_TAIL_CHARACTERS)}`);
  });
});
