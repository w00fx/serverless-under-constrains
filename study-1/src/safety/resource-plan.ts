// The conservative resource plan of one execution (BR-RUA-040 "conservative resource and spending
// estimates", BR-RUA-046, design §10.1 A14). Every quantity is an upper bound built from the
// declared resources and the active-time maximum, never from expected traffic:
// - every function is assumed busy for the whole active window (512 MB, D-22), one invocation
//   per second;
// - every table is read at the treatment-state polling rate and written once per second, and the
//   caller-journal stream is polled at that rate too;
// - every FIFO queue is polled by five event-source-mapping pollers each second, and the
//   controller's standard on-failure queue once per second;
// - a Durable caller performs one durable operation per second;
// - every function writes 1 KB of logs per second.
// Resource counts follow the constructs of design §9.2: ExperimentCore's five tables, provider,
// controller and on-failure queue in every kind; the probe caller in a probe; each deployed
// variant's caller function and FIFO source and dead-letter queues.

import type { ExecutionKind, VariantId } from '../record-contract/primitives.ts';
import type { PriceMeter } from './price-ceilings.ts';

/** D-22: every function runs with 512 MB. */
export const FUNCTION_MEMORY_MB = 512;
const MB_PER_GB = 1024;
const SQS_ESM_POLLERS = 5;
const LOG_KB_PER_FUNCTION_SECOND = 1;
const KB_PER_MB = 1000;
const EXPERIMENT_CORE_TABLES = 5;
const EXPERIMENT_CORE_FUNCTIONS = 2;
const FIFO_QUEUES_PER_VARIANT = 2;

export interface PlannedUsage {
  readonly meter: PriceMeter;
  /** A nonnegative safe integer count of the meter's unit. */
  readonly quantity: number;
}

export interface ResourcePlan {
  readonly usage: readonly PlannedUsage[];
  /** Resource kind (snake_case) to its planned count, as the manifest declares it. */
  readonly resource_counts: Readonly<Record<string, number>>;
}

export interface ResourcePlanInput {
  readonly kind: ExecutionKind;
  /** The single variant of a variant validation; ignored for a run and a probe. */
  readonly variant_id?: VariantId;
  readonly active_ms: number;
  /** OR-RUA-002 treatment-state polling interval. */
  readonly treatment_poll_interval_ms: number;
}

/**
 * Plans the conservative usage of one execution.
 *
 * @example
 * planExecutionResources({ kind: 'RUN', active_ms: 4_500_000, treatment_poll_interval_ms: 250 }).resource_counts;
 * // { functions: 4, tables: 5, fifo_queues: 4, standard_queues: 1 }
 */
export function planExecutionResources(input: ResourcePlanInput): ResourcePlan {
  const variants = deployedVariants(input);
  const functions = EXPERIMENT_CORE_FUNCTIONS + variants.length + (input.kind === 'TRANSPORT_PROBE' ? 1 : 0);
  const fifoQueues = FIFO_QUEUES_PER_VARIANT * variants.length;
  const activeSeconds = Math.ceil(input.active_ms / 1000);
  const pollsPerSecond = Math.ceil(1000 / input.treatment_poll_interval_ms);
  const functionSeconds = functions * activeSeconds;
  return {
    usage: [
      { meter: 'lambda_requests', quantity: functionSeconds },
      { meter: 'lambda_gb_seconds', quantity: Math.ceil((functionSeconds * FUNCTION_MEMORY_MB) / MB_PER_GB) },
      { meter: 'lambda_durable_operations', quantity: variants.includes('durable') ? activeSeconds : 0 },
      { meter: 'dynamodb_write_request_units', quantity: EXPERIMENT_CORE_TABLES * activeSeconds },
      { meter: 'dynamodb_read_request_units', quantity: EXPERIMENT_CORE_TABLES * activeSeconds * pollsPerSecond },
      { meter: 'dynamodb_stream_read_request_units', quantity: activeSeconds * pollsPerSecond },
      { meter: 'sqs_fifo_requests', quantity: fifoQueues * SQS_ESM_POLLERS * activeSeconds },
      { meter: 'sqs_standard_requests', quantity: activeSeconds },
      {
        meter: 'cloudwatch_logs_ingested_mb',
        quantity: Math.ceil((functionSeconds * LOG_KB_PER_FUNCTION_SECOND) / KB_PER_MB),
      },
    ],
    resource_counts: { functions, tables: EXPERIMENT_CORE_TABLES, fifo_queues: fifoQueues, standard_queues: 1 },
  };
}

function deployedVariants(input: ResourcePlanInput): readonly VariantId[] {
  if (input.kind === 'RUN') {
    return ['conventional', 'durable'];
  }
  if (input.kind === 'VARIANT_VALIDATION' && input.variant_id !== undefined) {
    return [input.variant_id];
  }
  return [];
}
