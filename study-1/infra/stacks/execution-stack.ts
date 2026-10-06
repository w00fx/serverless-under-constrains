// The run-owned execution stack `SucRua-<kind>-<p>` (design §9.1, §9.2, §9.7; D-07, D-08;
// BR-RUA-040, BR-RUA-050, BR-RUA-053). One stack per execution is the ownership boundary, and its
// construct tree depends only on the execution kind:
// - every kind deploys the ExperimentCore (tables, provider and its published version,
//   controller and its stream mapping);
// - a transport probe adds the ProbeCaller and no variant;
// - a canonical run adds both variants; a variant validation adds only the variant it validates.
// The construct ids are fixed: the transport scope selects the core by its snake-cased path
// (`experiment_core`), and the deployment projection and resource manifest find resources by
// these stack-relative construct paths.
//
// The stack carries every `suc:*` ownership tag of its execution (the variants add
// `suc:variant_id` to their own resources), an explicit account and Region so synthesis performs
// no lookup, and the outputs the runner needs to address what CloudFormation named: function
// names, published versions, alias ARNs and queue URLs. It never carries the execution-manifest
// digest, which would be circular (design §9.1).

import { CfnOutput, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import { ConventionalVariant } from '../constructs/conventional-variant.ts';
import { DurableVariant } from '../constructs/durable-variant.ts';
import { EXPERIMENT_CORE_ID, ExperimentCore } from '../constructs/experiment-core.ts';
import { ProbeCaller } from '../constructs/probe-caller.ts';
import type { ExecutionSynthContext } from '../ownership/execution-context.ts';
import { applyOwnershipTags, executionOwnershipTags } from '../ownership/ownership-tags.ts';
import { stackName } from '../ownership/resource-naming.ts';

/** The construct ids below the stack; the deployment readers select resources by them. */
export const EXECUTION_CONSTRUCT_IDS = {
  core: EXPERIMENT_CORE_ID,
  probeCaller: 'ProbeCaller',
  conventional: 'ConventionalVariant',
  durable: 'DurableVariant',
} as const;

/** The CloudFormation output keys of an execution stack (letters and digits only). */
export const EXECUTION_STACK_OUTPUTS = {
  providerFunctionName: 'ProviderFunctionName',
  providerVersion: 'ProviderVersion',
  controllerFunctionName: 'ControllerFunctionName',
  controllerFailureQueueUrl: 'ControllerFailureQueueUrl',
  probeCallerFunctionName: 'ProbeCallerFunctionName',
  probeCallerVersion: 'ProbeCallerVersion',
  conventionalCallerFunctionName: 'ConventionalCallerFunctionName',
  conventionalCallerAliasArn: 'ConventionalCallerAliasArn',
  conventionalSourceQueueUrl: 'ConventionalSourceQueueUrl',
  conventionalDeadLetterQueueUrl: 'ConventionalDeadLetterQueueUrl',
  durableCallerFunctionName: 'DurableCallerFunctionName',
  durableCallerFunctionArn: 'DurableCallerFunctionArn',
  durableCallerAliasArn: 'DurableCallerAliasArn',
  durableSourceQueueUrl: 'DurableSourceQueueUrl',
  durableDeadLetterQueueUrl: 'DurableDeadLetterQueueUrl',
} as const;

export interface ExecutionStackProps {
  readonly context: ExecutionSynthContext;
  /** Bundling root and lockfile; default to the study root and its committed lockfile. */
  readonly projectRoot?: string;
  readonly depsLockFilePath?: string;
}

/**
 * The one CloudFormation stack of an execution, composed for its kind.
 *
 * @example
 * const stack = new ExecutionStack(app, { context });
 * stack.stackName; // 'SucRua-run-3f1c2a9e'
 */
export class ExecutionStack extends Stack {
  readonly core: ExperimentCore;
  readonly probeCaller: ProbeCaller | undefined;
  readonly conventional: ConventionalVariant | undefined;
  readonly durable: DurableVariant | undefined;

  constructor(scope: Construct, props: ExecutionStackProps) {
    const { context } = props;
    const name = stackName(context.execution_kind, context.execution_id);
    super(scope, name, {
      stackName: name,
      env: { account: context.account, region: context.region },
      description: `Study 1 run-owned ${context.execution_kind} execution ${context.execution_id} (CAP-RUA).`,
    });
    const bundling = {
      ...(props.projectRoot === undefined ? {} : { projectRoot: props.projectRoot }),
      ...(props.depsLockFilePath === undefined ? {} : { depsLockFilePath: props.depsLockFilePath }),
    };
    const shared = { context, ...bundling };
    this.core = new ExperimentCore(this, EXECUTION_CONSTRUCT_IDS.core, shared);
    const withCore = { ...shared, core: this.core };
    this.probeCaller =
      context.execution_kind === 'TRANSPORT_PROBE'
        ? new ProbeCaller(this, EXECUTION_CONSTRUCT_IDS.probeCaller, withCore)
        : undefined;
    this.conventional = deploysVariant(context, 'conventional')
      ? new ConventionalVariant(this, EXECUTION_CONSTRUCT_IDS.conventional, withCore)
      : undefined;
    this.durable = deploysVariant(context, 'durable')
      ? new DurableVariant(this, EXECUTION_CONSTRUCT_IDS.durable, withCore)
      : undefined;
    applyOwnershipTags(this, executionOwnershipTags(context));
    this.#addOutputs();
  }

  #addOutputs(): void {
    const keys = EXECUTION_STACK_OUTPUTS;
    this.#output(keys.providerFunctionName, this.core.provider.function.functionName);
    this.#output(keys.providerVersion, this.core.providerVersion.version);
    this.#output(keys.controllerFunctionName, this.core.controller.function.functionName);
    this.#output(keys.controllerFailureQueueUrl, this.core.controllerFailureQueue.queueUrl);
    if (this.probeCaller !== undefined) {
      this.#output(keys.probeCallerFunctionName, this.probeCaller.caller.function.functionName);
      this.#output(keys.probeCallerVersion, this.probeCaller.callerVersion.version);
    }
    if (this.conventional !== undefined) {
      this.#output(keys.conventionalCallerFunctionName, this.conventional.caller.function.functionName);
      this.#output(keys.conventionalCallerAliasArn, this.conventional.alias.functionArn);
      this.#output(keys.conventionalSourceQueueUrl, this.conventional.source.queue.queueUrl);
      this.#output(keys.conventionalDeadLetterQueueUrl, this.conventional.source.deadLetterQueue.queueUrl);
    }
    if (this.durable !== undefined) {
      this.#output(keys.durableCallerFunctionName, this.durable.caller.function.functionName);
      this.#output(keys.durableCallerFunctionArn, this.durable.caller.function.functionArn);
      this.#output(keys.durableCallerAliasArn, this.durable.alias.functionArn);
      this.#output(keys.durableSourceQueueUrl, this.durable.source.queue.queueUrl);
      this.#output(keys.durableDeadLetterQueueUrl, this.durable.source.deadLetterQueue.queueUrl);
    }
  }

  #output(key: string, value: string): void {
    new CfnOutput(this, key, { value });
  }
}

// A run deploys both variants; a validation deploys only the one its context names; a probe none.
function deploysVariant(context: ExecutionSynthContext, variant: 'conventional' | 'durable'): boolean {
  if (context.execution_kind === 'RUN') {
    return true;
  }
  return context.execution_kind === 'VARIANT_VALIDATION' && context.variant_id === variant;
}
