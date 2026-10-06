// The conservative resource plan of each execution kind (BR-RUA-046, design §10.1 A14).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FUNCTION_MEMORY_MB, planExecutionResources } from '../../../src/safety/resource-plan.ts';

function quantities(plan: ReturnType<typeof planExecutionResources>): Readonly<Record<string, number>> {
  return Object.fromEntries(plan.usage.map((usage) => [usage.meter, usage.quantity]));
}

describe('planExecutionResources', () => {
  it('plans a run with both variants over its active window', () => {
    const plan = planExecutionResources({ kind: 'RUN', active_ms: 4_500_000, treatment_poll_interval_ms: 250 });
    assert.equal(FUNCTION_MEMORY_MB, 512);
    assert.deepEqual(plan.resource_counts, { functions: 4, tables: 5, fifo_queues: 4, standard_queues: 1 });
    assert.deepEqual(quantities(plan), {
      lambda_requests: 18_000,
      lambda_gb_seconds: 9_000,
      lambda_durable_operations: 4_500,
      dynamodb_write_request_units: 22_500,
      dynamodb_read_request_units: 90_000,
      dynamodb_stream_read_request_units: 18_000,
      sqs_fifo_requests: 90_000,
      sqs_standard_requests: 4_500,
      cloudwatch_logs_ingested_mb: 18,
    });
  });

  it('plans a probe with the caller and no variant', () => {
    const plan = planExecutionResources({
      kind: 'TRANSPORT_PROBE',
      active_ms: 600_000,
      treatment_poll_interval_ms: 250,
    });
    assert.deepEqual(plan.resource_counts, { functions: 3, tables: 5, fifo_queues: 0, standard_queues: 1 });
    assert.deepEqual(quantities(plan), {
      lambda_requests: 1_800,
      lambda_gb_seconds: 900,
      lambda_durable_operations: 0,
      dynamodb_write_request_units: 3_000,
      dynamodb_read_request_units: 12_000,
      dynamodb_stream_read_request_units: 2_400,
      sqs_fifo_requests: 0,
      sqs_standard_requests: 600,
      cloudwatch_logs_ingested_mb: 2,
    });
  });

  it('plans a durable validation with its one variant and durable operations', () => {
    const plan = planExecutionResources({
      kind: 'VARIANT_VALIDATION',
      variant_id: 'durable',
      active_ms: 1_000,
      treatment_poll_interval_ms: 300,
    });
    assert.deepEqual(plan.resource_counts, { functions: 3, tables: 5, fifo_queues: 2, standard_queues: 1 });
    assert.deepEqual(quantities(plan), {
      lambda_requests: 3,
      lambda_gb_seconds: 2,
      lambda_durable_operations: 1,
      dynamodb_write_request_units: 5,
      dynamodb_read_request_units: 20,
      dynamodb_stream_read_request_units: 4,
      sqs_fifo_requests: 10,
      sqs_standard_requests: 1,
      cloudwatch_logs_ingested_mb: 1,
    });
  });

  it('plans a conventional validation without durable operations', () => {
    const plan = planExecutionResources({
      kind: 'VARIANT_VALIDATION',
      variant_id: 'conventional',
      active_ms: 1_001,
      treatment_poll_interval_ms: 250,
    });
    assert.equal(quantities(plan)['lambda_durable_operations'], 0);
    assert.equal(quantities(plan)['sqs_standard_requests'], 2);
  });

  it('plans no variant for a validation that names none', () => {
    const plan = planExecutionResources({
      kind: 'VARIANT_VALIDATION',
      active_ms: 1_000,
      treatment_poll_interval_ms: 250,
    });
    assert.deepEqual(plan.resource_counts, { functions: 2, tables: 5, fifo_queues: 0, standard_queues: 1 });
  });
});
