// The transport probe's caller function (design §9.2, §9.4, §9.6; BR-RUA-027): deployed only in
// a probe stack, invoked once and synchronously by the runner (`RequestResponse`; Lambda does not
// retry synchronous invokes), 10 s timeout, with its own published version. Its role may write
// only the caller journal (PutItem, UpdateItem, GetItem, ConditionCheckItem) and invoke only the
// provider's published version: never `$LATEST`, an alias or another function, and never the
// ledger, `control` or the experiment journal (BR-RUA-018).

import { fileURLToPath } from 'node:url';

import { Duration } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Version } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

import type { ExecutionSynthContext } from '../ownership/execution-context.ts';
import { tableName } from '../ownership/resource-naming.ts';
import type { ExperimentCore } from './experiment-core.ts';
import { ObservableFunction } from './observable-function.ts';

export const PROBE_CALLER_TIMEOUT = Duration.seconds(10);

const PROBE_CALLER_ENTRY = fileURLToPath(
  new URL('../../src/transport-probe-caller/transport-probe-caller.handler.ts', import.meta.url),
);

export interface ProbeCallerProps {
  readonly context: ExecutionSynthContext;
  readonly core: ExperimentCore;
  /** Bundling root and lockfile; default to the study root and its committed lockfile. */
  readonly projectRoot?: string;
  readonly depsLockFilePath?: string;
}

/**
 * The probe caller of a transport-probe execution. Throws an Error for any other execution kind.
 *
 * @example
 * const core = new ExperimentCore(stack, EXPERIMENT_CORE_ID, { context });
 * const probe = new ProbeCaller(stack, 'ProbeCaller', { context, core });
 */
export class ProbeCaller extends Construct {
  readonly caller: ObservableFunction;
  /** The published version the runner invokes. */
  readonly callerVersion: Version;

  constructor(scope: Construct, id: string, props: ProbeCallerProps) {
    super(scope, id);
    if (props.context.execution_kind !== 'TRANSPORT_PROBE') {
      throw new Error(
        `ProbeCaller in a ${props.context.execution_kind} execution; expected TRANSPORT_PROBE (design §9.2)`,
      );
    }
    const providerVersion = props.core.providerVersion;
    this.caller = new ObservableFunction(this, 'Caller', {
      context: props.context,
      logicalName: 'probe-caller',
      entry: PROBE_CALLER_ENTRY,
      timeout: PROBE_CALLER_TIMEOUT,
      environment: {
        SUC_TABLE_CALLER_JOURNAL: tableName(props.context.execution_id, 'caller-journal'),
        SUC_PROVIDER_FUNCTION_NAME: props.core.provider.function.functionName,
        SUC_PROVIDER_QUALIFIER: providerVersion.version,
      },
      ...(props.projectRoot === undefined ? {} : { projectRoot: props.projectRoot }),
      ...(props.depsLockFilePath === undefined ? {} : { depsLockFilePath: props.depsLockFilePath }),
    });
    this.callerVersion = this.caller.function.currentVersion;
    this.caller.role.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:ConditionCheckItem'],
        resources: [props.core.tables['caller-journal'].tableArn],
      }),
    );
    this.caller.role.addToPolicy(
      new PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [providerVersion.functionArn] }),
    );
  }
}
