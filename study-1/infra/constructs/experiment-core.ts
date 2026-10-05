// The experiment core every execution kind deploys (design §9.2-§9.6): the five run-owned tables,
// the controlled refund provider and its published version, and the treatment controller fed by
// the caller-journal stream through a filtered event source mapping with a standard on-failure
// queue.
// - tables: `pk`/`sk` strings, on demand, removed with the stack, no GSI (strongly consistent
//   reads only), no TTL; only `caller-journal` has a stream, with `NEW_IMAGE` (§9.3);
// - IAM: exactly the §9.6 matrix. The provider writes the ledger only inside its commit
//   transaction (PutItem, no reads), puts experiment-journal events, and reads and conditionally
//   updates `control`. The controller puts experiment-journal events, reads `control` and makes
//   its one conditional update; the mapping grants its stream read and on-failure send;
// - mapping: TRIM_HORIZON, one record per batch, no batching window, one poller per shard,
//   2 retries, 1 h maximum record age, no bisection, and the filter that passes only INSERTs of
//   `caller_timeout_recorded` (§9.5, F-2). The handler re-checks both (defense in depth);
// - no provisioned concurrency anywhere (addendum §2): the runner warms the provider instead.
//
// The construct id must be `ExperimentCore`: the transport scope selects its resources by the
// snake-cased construct path `experiment_core` (transport-scope.policy.json).

import { fileURLToPath } from 'node:url';

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Role } from 'aws-cdk-lib/aws-iam';
import { StartingPosition } from 'aws-cdk-lib/aws-lambda';
import type { Version } from 'aws-cdk-lib/aws-lambda';
import { SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import type { ExecutionSynthContext } from '../ownership/execution-context.ts';
import { RUN_OWNED_TABLE_ROLES, controllerFailureQueueName, tableName } from '../ownership/resource-naming.ts';
import type { RunOwnedTableRole } from '../ownership/resource-naming.ts';
import { ObservableFunction } from './observable-function.ts';

/** The construct id the transport scope selects (`experiment_core`). */
export const EXPERIMENT_CORE_ID = 'ExperimentCore';
export const PROVIDER_TIMEOUT = Duration.seconds(30);
export const CONTROLLER_TIMEOUT = Duration.seconds(30);

/** The controller mapping settings of design §9.5. */
export const CONTROLLER_STREAM_SETTINGS = {
  batch_size: 1,
  maximum_batching_window_s: 0,
  parallelization_factor: 1,
  maximum_retry_attempts: 2,
  maximum_record_age_s: 3600,
} as const;

/**
 * The mapping's filter pattern (F-2). Infra may not import the controller, so the pattern is
 * restated here; the synth test asserts it equals the controller's `CONTROLLER_STREAM_FILTER`.
 */
export const CALLER_TIMEOUT_INSERT_FILTER = {
  eventName: ['INSERT'],
  dynamodb: { NewImage: { record_type: { S: ['caller_timeout_recorded'] } } },
} as const;

const PROVIDER_ENTRY = fileURLToPath(new URL('../../src/refund-provider/refund-provider.handler.ts', import.meta.url));
const CONTROLLER_ENTRY = fileURLToPath(
  new URL('../../src/treatment-controller/treatment-controller.handler.ts', import.meta.url),
);

export interface ExperimentCoreProps {
  readonly context: ExecutionSynthContext;
  /** Bundling root and lockfile; default to the study root and its committed lockfile. */
  readonly projectRoot?: string;
  readonly depsLockFilePath?: string;
}

/**
 * The tables, provider, controller and controller mapping of one execution.
 *
 * @example
 * const core = new ExperimentCore(stack, EXPERIMENT_CORE_ID, { context });
 * new ProbeCaller(stack, 'ProbeCaller', { context, core });
 */
export class ExperimentCore extends Construct {
  readonly tables: Readonly<Record<RunOwnedTableRole, Table>>;
  readonly provider: ObservableFunction;
  /** The published provider version every caller invokes, never `$LATEST` (BR-RUA-053). */
  readonly providerVersion: Version;
  readonly controller: ObservableFunction;
  readonly controllerFailureQueue: Queue;

  constructor(scope: Construct, id: string, props: ExperimentCoreProps) {
    super(scope, id);
    const executionId = props.context.execution_id;
    this.tables = createTables(this, props.context);
    const bundling = {
      ...(props.projectRoot === undefined ? {} : { projectRoot: props.projectRoot }),
      ...(props.depsLockFilePath === undefined ? {} : { depsLockFilePath: props.depsLockFilePath }),
    };
    this.provider = new ObservableFunction(this, 'Provider', {
      context: props.context,
      logicalName: 'refund-provider',
      entry: PROVIDER_ENTRY,
      timeout: PROVIDER_TIMEOUT,
      environment: {
        SUC_TABLE_LEDGER: tableName(executionId, 'ledger'),
        SUC_TABLE_EXPERIMENT_JOURNAL: tableName(executionId, 'experiment-journal'),
        SUC_TABLE_CONTROL: tableName(executionId, 'control'),
      },
      ...bundling,
    });
    this.providerVersion = this.provider.function.currentVersion;
    this.controller = new ObservableFunction(this, 'Controller', {
      context: props.context,
      logicalName: 'treatment-controller',
      entry: CONTROLLER_ENTRY,
      timeout: CONTROLLER_TIMEOUT,
      environment: {
        SUC_TABLE_EXPERIMENT_JOURNAL: tableName(executionId, 'experiment-journal'),
        SUC_TABLE_CONTROL: tableName(executionId, 'control'),
      },
      ...bundling,
    });
    this.controllerFailureQueue = new Queue(this, 'ControllerFailure', {
      queueName: controllerFailureQueueName(executionId),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.#grantProvider(this.provider.role);
    this.#grantController(this.controller.role);
    this.#mapCallerJournalStream();
  }

  #grantProvider(role: Role): void {
    allow(role, ['dynamodb:PutItem'], this.tables.ledger);
    allow(role, ['dynamodb:PutItem'], this.tables['experiment-journal']);
    allow(role, ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem'], this.tables.control);
  }

  #grantController(role: Role): void {
    allow(role, ['dynamodb:PutItem'], this.tables['experiment-journal']);
    allow(role, ['dynamodb:GetItem', 'dynamodb:UpdateItem'], this.tables.control);
  }

  #mapCallerJournalStream(): void {
    const settings = CONTROLLER_STREAM_SETTINGS;
    const journal = this.tables['caller-journal'];
    const streamArn = journal.tableStreamArn;
    if (streamArn === undefined) {
      throw new Error(`table ${journal.node.path} has no stream; expected the caller-journal NEW_IMAGE stream`);
    }
    journal.grantStreamRead(this.controller.role);
    this.controller.function.addEventSourceMapping('CallerJournalStream', {
      eventSourceArn: streamArn,
      startingPosition: StartingPosition.TRIM_HORIZON,
      batchSize: settings.batch_size,
      maxBatchingWindow: Duration.seconds(settings.maximum_batching_window_s),
      parallelizationFactor: settings.parallelization_factor,
      retryAttempts: settings.maximum_retry_attempts,
      maxRecordAge: Duration.seconds(settings.maximum_record_age_s),
      bisectBatchOnError: false,
      onFailure: new SqsDlq(this.controllerFailureQueue),
      filters: [{ pattern: JSON.stringify(CALLER_TIMEOUT_INSERT_FILTER) }],
    });
  }
}

function createTables(scope: Construct, context: ExecutionSynthContext): Readonly<Record<RunOwnedTableRole, Table>> {
  const entries = RUN_OWNED_TABLE_ROLES.map((role) => {
    const table = new Table(scope, tableConstructId(role), {
      tableName: tableName(context.execution_id, role),
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      ...(role === 'caller-journal' ? { stream: StreamViewType.NEW_IMAGE } : {}),
    });
    return [role, table] as const;
  });
  return Object.fromEntries(entries) as Record<RunOwnedTableRole, Table>;
}

// 'caller-journal' -> 'CallerJournalTable'
function tableConstructId(role: RunOwnedTableRole): string {
  const words = role.split('-').map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
  return `${words.join('')}Table`;
}

function allow(role: Role, actions: readonly string[], table: Table): void {
  role.addToPolicy(new PolicyStatement({ actions: [...actions], resources: [table.tableArn] }));
}
