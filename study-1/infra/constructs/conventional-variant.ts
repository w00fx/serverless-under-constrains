// The conventional variant (design §9.2, §9.4-9.7; BR-RUA-020, BR-RUA-053): a FIFO source with a
// 60 s visibility timeout and a FIFO DLQ after two receives (OR-RUA-002), and a caller function
// with a 10 s timeout behind its published version's `live` alias, which the event source
// mapping invokes with batch size 1. The mapping sets no batching window (CDK throws for FIFO),
// no scaling or provisioned-poller configuration and no filter (SQS deletes messages a filter
// drops), and nothing has provisioned concurrency (addendum §2).
//
// The caller role may touch the caller journal and read the trial registry, and invoke only the
// provider's published version. It never reaches the ledger, the control table or the
// experiment journal (BR-RUA-018). Beyond the §9.6 matrix it may query the caller journal: the
// orphan reconciliation reads the trial partition of its own journal (WP-20 decision log row 5).

import { fileURLToPath } from 'node:url';

import { Duration } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Alias, Version } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';

import type { ExecutionSynthContext } from '../ownership/execution-context.ts';
import { applyOwnershipTags, variantTag } from '../ownership/ownership-tags.ts';
import { tableName } from '../ownership/resource-naming.ts';
import type { ExperimentCore } from './experiment-core.ts';
import { FifoMessageSource } from './fifo-message-source.ts';
import { ObservableFunction } from './observable-function.ts';

/** OR-RUA-002: the conventional invocation timeout. */
export const CONVENTIONAL_CALLER_TIMEOUT = Duration.seconds(10);
/** OR-RUA-002: the conventional source's visibility timeout (six times the function timeout). */
export const CONVENTIONAL_VISIBILITY_TIMEOUT = Duration.seconds(60);
/** The alias the event source mapping invokes. */
export const CONVENTIONAL_ALIAS_NAME = 'live';

const CONVENTIONAL_CALLER_ENTRY = fileURLToPath(
  new URL('../../src/conventional-variant/conventional-variant.handler.ts', import.meta.url),
);

export interface ConventionalVariantProps {
  readonly context: ExecutionSynthContext;
  readonly core: ExperimentCore;
  /** Bundling root and lockfile; default to the study root and its committed lockfile. */
  readonly projectRoot?: string;
  readonly depsLockFilePath?: string;
}

/**
 * The conventional variant of a run, or of a variant validation of the conventional variant.
 * Throws an Error in a transport probe or in a validation of the Durable variant.
 *
 * @example
 * const core = new ExperimentCore(stack, EXPERIMENT_CORE_ID, { context });
 * const conventional = new ConventionalVariant(stack, 'ConventionalVariant', { context, core });
 */
export class ConventionalVariant extends Construct {
  readonly source: FifoMessageSource;
  readonly caller: ObservableFunction;
  /** The published version the alias points to (the function's `currentVersion`). */
  readonly callerVersion: Version;
  readonly alias: Alias;

  constructor(scope: Construct, id: string, props: ConventionalVariantProps) {
    super(scope, id);
    assertConventionalContext(props.context);
    const executionId = props.context.execution_id;
    const providerVersion = props.core.providerVersion;
    this.source = new FifoMessageSource(this, 'Source', {
      context: props.context,
      variant: 'conventional',
      visibilityTimeout: CONVENTIONAL_VISIBILITY_TIMEOUT,
    });
    this.caller = new ObservableFunction(this, 'Caller', {
      context: props.context,
      logicalName: 'conventional-caller',
      entry: CONVENTIONAL_CALLER_ENTRY,
      timeout: CONVENTIONAL_CALLER_TIMEOUT,
      environment: {
        SUC_TABLE_CALLER_JOURNAL: tableName(executionId, 'caller-journal'),
        SUC_TABLE_TRIAL_REGISTRY: tableName(executionId, 'trial-registry'),
        SUC_PROVIDER_FUNCTION_NAME: props.core.provider.function.functionName,
        SUC_PROVIDER_QUALIFIER: providerVersion.version,
        SUC_VARIANT_ID: 'conventional',
      },
      ...(props.projectRoot === undefined ? {} : { projectRoot: props.projectRoot }),
      ...(props.depsLockFilePath === undefined ? {} : { depsLockFilePath: props.depsLockFilePath }),
    });
    this.callerVersion = this.caller.function.currentVersion;
    this.alias = this.caller.function.addAlias(CONVENTIONAL_ALIAS_NAME);
    this.alias.addEventSource(new SqsEventSource(this.source.queue, { batchSize: 1 }));
    this.#grantCaller(props.core);
    applyOwnershipTags(this, [variantTag('conventional')]);
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

function assertConventionalContext(context: ExecutionSynthContext): void {
  if (context.execution_kind === 'TRANSPORT_PROBE') {
    throw new Error(
      'ConventionalVariant in a TRANSPORT_PROBE execution; expected a RUN or VARIANT_VALIDATION (design §9.2)',
    );
  }
  if (context.execution_kind === 'VARIANT_VALIDATION' && context.variant_id !== 'conventional') {
    throw new Error(
      `ConventionalVariant in a VARIANT_VALIDATION of variant ${String(context.variant_id)}; expected variant_id conventional (design §9.2)`,
    );
  }
}
