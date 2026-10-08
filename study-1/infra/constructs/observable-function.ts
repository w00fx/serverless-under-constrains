// The wrapper every study function uses (design §9.2, D-22, RK-11, RK-12):
// - Node.js 24 on x86_64 with 512 MB, so memory and architecture are never variant differences;
// - an explicit stack-owned log group `/suc/study-1/<execution_id>/<logical>` removed with the
//   stack, so Lambda never auto-creates the untagged `/aws/lambda/*` group that survives deletion;
// - an explicit role named `suc1-<p>-<logical>` that may write only its own log group;
// - local esbuild bundling with the AWS SDK bundled, so the frozen assembly binds the lockfile
//   versions instead of the runtime-provided SDK, and never a Docker fallback;
// - no explicit function name (a Durable function must not have one, [R-durable]) and no
//   provisioned concurrency (addendum §2).

import { RemovalPolicy } from 'aws-cdk-lib';
import type { Duration } from 'aws-cdk-lib';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import type { DurableConfig } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import type { ExecutionSynthContext } from '../ownership/execution-context.ts';
import { logGroupName, roleName } from '../ownership/resource-naming.ts';

export const FUNCTION_MEMORY_MB = 512;
export const RESERVED_ENVIRONMENT_KEYS = ['SUC_EXECUTION_KIND', 'SUC_EXECUTION_ID'] as const;

// esbuild emits a throwing `require` shim when an ESM bundle inlines CommonJS code that
// requires Node built-ins; restoring `require` through createRequire keeps the bundle loadable.
// The import is aliased because esbuild treats the banner as opaque text and cannot rename around
// it: an inlined ESM module with its own top-level `createRequire` (the durable SDK) would
// otherwise fail at load with "Identifier 'createRequire' has already been declared" (WP-21).
const ESM_REQUIRE_BANNER =
  "import { createRequire as suc_createRequire } from 'node:module'; const require = suc_createRequire(import.meta.url);";

export interface ObservableFunctionProps {
  readonly context: ExecutionSynthContext;
  /** Lowercase kebab-case name used in the log group and role names. */
  readonly logicalName: string;
  /** Path of the handler module (a `*.handler.ts` entry in production). */
  readonly entry: string;
  readonly timeout: Duration;
  readonly environment?: Readonly<Record<string, string>>;
  readonly durableConfig?: DurableConfig;
  /** Bundling root and lockfile; default to the study root and its committed lockfile. */
  readonly projectRoot?: string;
  readonly depsLockFilePath?: string;
}

/**
 * A Lambda function with the study's observability, naming and bundling guarantees.
 *
 * @example
 * const provider = new ObservableFunction(core, 'Provider', {
 *   context, logicalName: 'refund-provider', entry: 'src/refund-provider/refund-provider.handler.ts',
 *   timeout: Duration.seconds(30),
 * });
 * table.grantReadData(provider.function);
 */
export class ObservableFunction extends Construct {
  readonly function: NodejsFunction;
  readonly logGroup: LogGroup;
  readonly role: Role;

  constructor(scope: Construct, id: string, props: ObservableFunctionProps) {
    super(scope, id);
    const executionId = props.context.execution_id;
    this.logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: logGroupName(executionId, props.logicalName),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.role = new Role(this, 'Role', {
      roleName: roleName(executionId, props.logicalName),
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    this.logGroup.grantWrite(this.role);
    this.function = new NodejsFunction(this, 'Function', {
      entry: props.entry,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.X86_64,
      memorySize: FUNCTION_MEMORY_MB,
      timeout: props.timeout,
      role: this.role,
      logGroup: this.logGroup,
      environment: functionEnvironment(props),
      ...(props.durableConfig === undefined ? {} : { durableConfig: props.durableConfig }),
      ...(props.projectRoot === undefined ? {} : { projectRoot: props.projectRoot }),
      ...(props.depsLockFilePath === undefined ? {} : { depsLockFilePath: props.depsLockFilePath }),
      bundling: {
        bundleAwsSDK: true,
        forceDockerBundling: false,
        format: OutputFormat.ESM,
        mainFields: ['module', 'main'],
        banner: ESM_REQUIRE_BANNER,
        target: 'node24',
        minify: false,
        sourceMap: false,
      },
    });
  }
}

function functionEnvironment(props: ObservableFunctionProps): Record<string, string> {
  const extra = props.environment ?? {};
  const clashes = RESERVED_ENVIRONMENT_KEYS.filter((key) => Object.hasOwn(extra, key));
  if (clashes.length > 0) {
    throw new Error(`environment sets reserved key(s) ${clashes.join(', ')}; expected ObservableFunction to own them`);
  }
  return {
    ...extra,
    SUC_EXECUTION_KIND: props.context.execution_kind,
    SUC_EXECUTION_ID: props.context.execution_id,
  };
}
