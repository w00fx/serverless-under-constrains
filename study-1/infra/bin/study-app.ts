// The run-owned execution assembly (design §5.1, §9.1, §9.8 S1; BR-RUA-042, D-25). Admission
// synthesizes it exactly once:
//   cdk synth --app "node infra/bin/study-app.ts" -o <attempt>/staging/cdk.out
//     --context suc:execution=<attempt>/execution-context.json
// The context file names the execution (kind, id, account, Region, admission time, total target and,
// for a validation, its variant); the app builds the one ExecutionStack of that execution and
// nothing else. Synthesis performs no lookup (explicit account and Region) and keeps the
// `aws:cdk:path` metadata on, because the transport scope, the resource manifest and the deployment
// projection find resources by construct path. Version reporting is off, so the assembly holds no
// `AWS::CDK::Metadata` resource and every resource it declares is a study resource.
//
// The frozen copy of the result is deployed later with `cdk deploy --app <verified copy>`, which
// never runs this file again (D-25).

import { App } from 'aws-cdk-lib';
import { PATH_METADATA_ENABLE_CONTEXT } from 'aws-cdk-lib/cx-api';

import { readExecutionSynthContext } from '../ownership/execution-context.ts';
import { ExecutionStack } from '../stacks/execution-stack.ts';

export interface StudyAppOptions {
  /** Where `app.synth()` writes the cloud assembly; the CDK CLI sets it through the environment. */
  readonly outdir?: string;
  /** Extra CDK context; tests pass `suc:execution` here, the CLI passes it with `--context`. */
  readonly context?: Readonly<Record<string, string>>;
  /** Bundling root and lockfile; default to the study root and its committed lockfile. */
  readonly projectRoot?: string;
  readonly depsLockFilePath?: string;
}

export interface StudyApp {
  readonly app: App;
  readonly stack: ExecutionStack;
}

/**
 * Builds the execution assembly of the execution named by the `suc:execution` context. Throws an
 * Error naming the offending value when the context is absent or invalid.
 *
 * @example
 * const { app, stack } = buildStudyApp({ outdir, context: { 'suc:execution': contextPath } });
 * app.synth(); // writes <stack.stackName>.template.json into outdir
 */
export function buildStudyApp(options: StudyAppOptions = {}): StudyApp {
  const app = new App({
    ...(options.outdir === undefined ? {} : { outdir: options.outdir }),
    analyticsReporting: false,
    context: { [PATH_METADATA_ENABLE_CONTEXT]: true, ...options.context },
  });
  const context = readExecutionSynthContext(app);
  const stack = new ExecutionStack(app, {
    context,
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    ...(options.depsLockFilePath === undefined ? {} : { depsLockFilePath: options.depsLockFilePath }),
  });
  return { app, stack };
}

if (import.meta.main) {
  buildStudyApp().app.synth();
}
