// In-process synthesis of the study app for one execution (design §9.8 S1): the context file is
// written where the CLI's `--context suc:execution=<file>` would point, `buildStudyApp` composes
// the one ExecutionStack, and the cloud assembly is written to `<work>/cdk.out` with local esbuild
// bundling under the Docker sentinel (RK-11, CF V-10). Nothing touches AWS.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Template } from 'aws-cdk-lib/assertions';

import { buildStudyApp } from '../../../infra/bin/study-app.ts';
import { EXECUTION_CONTEXT_KEY } from '../../../infra/ownership/execution-context.ts';
import type { ExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import type { ExecutionStack } from '../../../infra/stacks/execution-stack.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';

export const STUDY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DOCKER_SENTINEL = join(STUDY_ROOT, 'tools/docker-forbidden.sh');

export interface SynthesizedExecution {
  readonly stack: ExecutionStack;
  readonly template: Template;
  readonly json: JsonObject;
  /** The written cloud assembly directory. */
  readonly assemblyDir: string;
}

/**
 * Synthesizes the execution named by `context` below `workDir`.
 *
 * @example
 * const run = synthesizeExecution(synthContext('RUN'), mkdtempSync(join(tmpdir(), 'rua-')));
 * run.template.resourceCountIs('AWS::Lambda::Alias', 2);
 */
export function synthesizeExecution(context: ExecutionSynthContext, workDir: string): SynthesizedExecution {
  process.env['CDK_DOCKER'] = DOCKER_SENTINEL;
  mkdirSync(workDir, { recursive: true });
  const contextFile = join(workDir, 'execution-context.json');
  writeFileSync(contextFile, `${JSON.stringify(context)}\n`);
  const { app, stack } = buildStudyApp({
    outdir: join(workDir, 'cdk.out'),
    context: { [EXECUTION_CONTEXT_KEY]: contextFile },
  });
  const assembly = app.synth();
  const template = Template.fromStack(stack);
  return { stack, template, json: template.toJSON(), assemblyDir: assembly.directory };
}
