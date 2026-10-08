// The Durable variant (design §9.2, §9.4-9.7; BR-RUA-020, BR-RUA-053, OR-RUA-002): a FIFO source
// with a 360 s visibility timeout (at least the 300 s execution timeout) and a FIFO DLQ after two
// receives, and a durable caller function (10 s per invocation, `durableConfig` with a 300 s
// execution timeout and 1 day retention) behind its published version's `live` alias, which the
// event source mapping invokes with batch size 1. A durable function needs a qualified target
// ([R-durable]) and is durable from creation, with no explicit function name (ObservableFunction
// sets none). The mapping sets no batching window (CDK throws for FIFO), no scaling or
// provisioned-poller configuration and no filter, and nothing has provisioned concurrency
// (addendum §2).
//
// The caller role has the conventional caller's grants (caller journal, trial-registry read, the
// provider's published version) and never reaches the ledger, the control table or the
// experiment journal (BR-RUA-018). CDK attaches `AWSLambdaBasicDurableExecutionRolePolicy` only
// to a role it creates itself; ObservableFunction passes its own role, so this construct grants
// the policy's two durable actions explicitly and only on the function's own durable executions
// (`<function arn>:*`, since execution ARNs are qualified by a version, durable-functions research
// §5). The managed policy's `logs:*` on `*` is not granted: the function writes only its own log
// group. The grant is a separate policy, so the function, which depends on its role's default
// policy, does not depend on a policy that names the function.

import { fileURLToPath } from 'node:url';

import { Duration } from 'aws-cdk-lib';
import { Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Alias, Version } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';

import type { ExecutionSynthContext } from '../ownership/execution-context.ts';
import { applyOwnershipTags, variantTag } from '../ownership/ownership-tags.ts';
import { tableName } from '../ownership/resource-naming.ts';
import type { ExperimentCore } from './experiment-core.ts';
import { FifoMessageSource } from './fifo-message-source.ts';
import { ObservableFunction } from './observable-function.ts';

/** OR-RUA-002: the Durable invocation timeout (each active phase of an execution). */
export const DURABLE_CALLER_TIMEOUT = Duration.seconds(10);
/** OR-RUA-002: the Durable execution timeout (the whole execution, retry delay included). */
export const DURABLE_EXECUTION_TIMEOUT = Duration.seconds(300);
/** Retention of a finished execution's history, set explicitly (durable-functions research R9). */
export const DURABLE_RETENTION_PERIOD = Duration.days(1);
/** OR-RUA-002: the Durable source's visibility timeout, beyond the whole execution. */
export const DURABLE_VISIBILITY_TIMEOUT = Duration.seconds(360);
/** The direct event-source invocation limit of a durable execution on on-demand capacity (BR-RUA-053). */
export const DURABLE_EVENT_SOURCE_LIMIT = Duration.minutes(15);
/** The alias the event source mapping invokes. */
export const DURABLE_ALIAS_NAME = 'live';
/** The durable-execution actions of `AWSLambdaBasicDurableExecutionRolePolicy`. */
export const DURABLE_EXECUTION_ACTIONS = [
  'lambda:CheckpointDurableExecution',
  'lambda:GetDurableExecutionState',
] as const;

const DURABLE_CALLER_ENTRY = fileURLToPath(
  new URL('../../src/durable-variant/durable-variant.handler.ts', import.meta.url),
);

export interface DurableVariantProps {
  readonly context: ExecutionSynthContext;
  readonly core: ExperimentCore;
  /** Bundling root and lockfile; default to the study root and its committed lockfile. */
  readonly projectRoot?: string;
  readonly depsLockFilePath?: string;
}

/**
 * The Durable variant of a run, or of a variant validation of the Durable variant. Throws an
 * Error in a transport probe or in a validation of the conventional variant.
 *
 * @example
 * const core = new ExperimentCore(stack, EXPERIMENT_CORE_ID, { context });
 * const durable = new DurableVariant(stack, 'DurableVariant', { context, core });
 */
export class DurableVariant extends Construct {
  readonly source: FifoMessageSource;
  readonly caller: ObservableFunction;
  /** The published version the alias points to (the function's `currentVersion`). */
  readonly callerVersion: Version;
  readonly alias: Alias;
  /** The checkpoint and state grant on the function's own durable executions. */
  readonly durableExecutionPolicy: Policy;

  constructor(scope: Construct, id: string, props: DurableVariantProps) {
    super(scope, id);
    assertDurableContext(props.context);
    const executionId = props.context.execution_id;
    this.source = new FifoMessageSource(this, 'Source', {
      context: props.context,
      variant: 'durable',
      visibilityTimeout: DURABLE_VISIBILITY_TIMEOUT,
    });
    this.caller = new ObservableFunction(this, 'Caller', {
      context: props.context,
      logicalName: 'durable-caller',
      entry: DURABLE_CALLER_ENTRY,
      timeout: DURABLE_CALLER_TIMEOUT,
      durableConfig: { executionTimeout: DURABLE_EXECUTION_TIMEOUT, retentionPeriod: DURABLE_RETENTION_PERIOD },
      environment: {
        SUC_TABLE_CALLER_JOURNAL: tableName(executionId, 'caller-journal'),
        SUC_TABLE_TRIAL_REGISTRY: tableName(executionId, 'trial-registry'),
        SUC_PROVIDER_FUNCTION_NAME: props.core.provider.function.functionName,
        SUC_PROVIDER_QUALIFIER: props.core.providerVersion.version,
        SUC_VARIANT_ID: 'durable',
      },
      ...(props.projectRoot === undefined ? {} : { projectRoot: props.projectRoot }),
      ...(props.depsLockFilePath === undefined ? {} : { depsLockFilePath: props.depsLockFilePath }),
    });
    this.callerVersion = this.caller.function.currentVersion;
    this.alias = this.caller.function.addAlias(DURABLE_ALIAS_NAME);
    this.alias.addEventSource(new SqsEventSource(this.source.queue, { batchSize: 1 }));
    this.#grantCaller(props.core);
    this.durableExecutionPolicy = new Policy(this, 'DurableExecutionPolicy', {
      roles: [this.caller.role],
      statements: [
        new PolicyStatement({
          actions: [...DURABLE_EXECUTION_ACTIONS],
          resources: [`${this.caller.function.functionArn}:*`],
        }),
      ],
    });
    applyOwnershipTags(this, [variantTag('durable')]);
  }

  #grantCaller(core: ExperimentCore): void {
    const role = this.caller.role;
    role.addToPolicy(
      new PolicyStatement({
        actions: [
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:GetItem',
          'dynamodb:ConditionCheckItem',
          'dynamodb:Query',
        ],
        resources: [core.tables['caller-journal'].tableArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [core.tables['trial-registry'].tableArn] }),
    );
    role.addToPolicy(
      new PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [core.providerVersion.functionArn] }),
    );
  }
}

function assertDurableContext(context: ExecutionSynthContext): void {
  if (context.execution_kind === 'TRANSPORT_PROBE') {
    throw new Error(
      'DurableVariant in a TRANSPORT_PROBE execution; expected a RUN or VARIANT_VALIDATION (design §9.2)',
    );
  }
  if (context.execution_kind === 'VARIANT_VALIDATION' && context.variant_id !== 'durable') {
    throw new Error(
      `DurableVariant in a VARIANT_VALIDATION of variant ${String(context.variant_id)}; expected variant_id durable (design §9.2)`,
    );
  }
}
