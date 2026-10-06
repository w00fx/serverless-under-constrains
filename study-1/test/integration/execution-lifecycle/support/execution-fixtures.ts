// The admitted executions the execution-lifecycle tests run: the offline cloud's run and
// conventional variant validation (golden identities, design §12.4), read back from the exact
// execution manifest bytes admission froze, and the targets their deployed stack would name.

import type {
  AdmittedTrialExecution,
  ExecutionLogLine,
  ExecutionServices,
  ExecutionTargets,
} from '../../../../src/execution-lifecycle/execution-ports.ts';
import type { Sleeper } from '../../../../src/record-contract/primitives.ts';
import { readAdmittedExecution } from '../../../../src/execution-lifecycle/admitted-execution.ts';
import { asTrialExecution } from '../../../../src/execution-lifecycle/trial-plans.ts';
import { EXECUTION_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import type { RecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import {
  GOLDEN_ACCOUNT_ID,
  GOLDEN_CALLER_VERSION,
  GOLDEN_PROVIDER_VERSION,
  GOLDEN_REGION,
} from '../../../support/golden-builder/golden-values.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import type { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import { queueTarget } from '../../../support/offline-cloud/offline-execution.ts';
import type { OfflineExecution } from '../../../support/offline-cloud/offline-execution.ts';

/** The event-source mapping of the deployed conventional source (readiness and cleanup step 3). */
export const SOURCE_MAPPING_ID = '5e5e5e5e-0000-4000-8000-0000000000e1';

let sharedValidator: RecordValidator | undefined;

/** The catalogue validator, compiled once per test process. */
export function lifecycleValidator(): RecordValidator {
  sharedValidator ??= createRecordValidator();
  return sharedValidator;
}

/**
 * The admitted execution of an offline execution, read from its frozen manifest bytes.
 *
 * @example
 * admittedOf(offlineExecution('run')).identity.execution_kind; // 'RUN'
 */
export function admittedOf(execution: OfflineExecution): AdmittedTrialExecution {
  const bytes = execution.core_files.get(EXECUTION_PATHS.executionManifest);
  if (bytes === undefined) {
    throw new Error(
      `${execution.name} has no frozen execution manifest; expected ${EXECUTION_PATHS.executionManifest}`,
    );
  }
  const read = readAdmittedExecution(bytes, lifecycleValidator());
  const admitted = read.ok ? asTrialExecution(read.value) : undefined;
  if (admitted === undefined) {
    throw new Error(`${execution.name} manifest is not an admitted trial execution; expected a run or validation`);
  }
  return admitted;
}

/**
 * The targets the execution's stack names: both variants' queues, the Durable caller version and
 * one source mapping, as `offlineTrialPlan` addresses them.
 *
 * @example
 * targetsOf(offlineExecution('run')).queues.conventional?.source.queue_name;
 */
export function targetsOf(execution: OfflineExecution): ExecutionTargets {
  const queues = (
    variant: 'conventional' | 'durable',
  ): { source: ReturnType<typeof queueTarget>; dlq: ReturnType<typeof queueTarget> } => ({
    source: queueTarget(execution.context, variant, 'source'),
    dlq: queueTarget(execution.context, variant, 'dlq'),
  });
  const callerName = `suc1-${execution.context.resource_prefix}-durable-caller`;
  return {
    provider_version: GOLDEN_PROVIDER_VERSION,
    queues: { conventional: queues('conventional'), durable: queues('durable') },
    durable_caller: {
      function_arn: `arn:aws:lambda:${GOLDEN_REGION}:${GOLDEN_ACCOUNT_ID}:function:${callerName}`,
      qualifier: GOLDEN_CALLER_VERSION,
    },
    event_source_mapping_ids: [SOURCE_MAPPING_ID],
    durable_function_names: [callerName],
  };
}

/** Runner services on one virtual time base, and the log lines they received. */
export interface RecordedServices {
  readonly services: ExecutionServices;
  readonly logs: ExecutionLogLine[];
}

/**
 * Services over `time`, sleeping on `sleeper` (the scheduler itself unless another is given).
 *
 * @example
 * const { services, logs } = lifecycleServices(cloud.time);
 */
export function lifecycleServices(time: VirtualTimeScheduler, sleeper: Sleeper = time): RecordedServices {
  const logs: ExecutionLogLine[] = [];
  return {
    services: {
      clock: time,
      monotonic: time,
      sleeper,
      ids: new SequentialUuidSource('e1e1e1e1'),
      validator: lifecycleValidator(),
      log: (line): void => {
        logs.push(line);
      },
    },
    logs,
  };
}
