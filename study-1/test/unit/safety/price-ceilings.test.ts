// The committed price ceilings (BR-RUA-046, D-19): one per meter, sourced and dated, and the SQS
// rows flagged UNVERIFIED because their price table could not be read on the retrieval date.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PRICE_CEILINGS, PRICE_METERS } from '../../../src/safety/price-ceilings.ts';
import { scaledUsd } from '../../../src/safety/usd-amount.ts';

describe('price ceilings', () => {
  it('price every meter exactly once, in meter order', () => {
    assert.deepEqual(
      PRICE_CEILINGS.map((price) => price.meter),
      [...PRICE_METERS],
    );
  });

  it('hold the published per-unit prices retrieved on 2026-10-06', () => {
    assert.deepEqual(
      PRICE_CEILINGS.map((price) => [price.meter, price.unit, price.usd_per_unit, price.source_status]),
      [
        ['lambda_requests', 'request', '0.0000002', 'verified'],
        ['lambda_gb_seconds', 'GB-second', '0.0000166667', 'verified'],
        ['lambda_durable_operations', 'durable operation', '0.000008', 'verified'],
        ['dynamodb_write_request_units', 'write request unit', '0.000000625', 'verified'],
        ['dynamodb_read_request_units', 'read request unit', '0.000000125', 'verified'],
        ['dynamodb_stream_read_request_units', 'stream read request unit', '0.0000002', 'verified'],
        ['sqs_fifo_requests', 'request', '0.0000005', 'UNVERIFIED'],
        ['sqs_standard_requests', 'request', '0.0000004', 'UNVERIFIED'],
        ['cloudwatch_logs_ingested_mb', 'MB ingested', '0.0005', 'verified'],
      ],
    );
    for (const price of PRICE_CEILINGS) {
      assert.equal(price.retrieved_on, '2026-10-06');
      assert.match(price.source_url, /^https:\/\/aws\.amazon\.com\/[a-z]+\/pricing\//);
      assert.notEqual(scaledUsd(price.usd_per_unit), undefined, price.meter);
    }
  });

  it('cite each service pricing page', () => {
    assert.deepEqual(
      [...new Set(PRICE_CEILINGS.map((price) => price.source_url))],
      [
        'https://aws.amazon.com/lambda/pricing/',
        'https://aws.amazon.com/dynamodb/pricing/on-demand/',
        'https://aws.amazon.com/sqs/pricing/',
        'https://aws.amazon.com/cloudwatch/pricing/',
      ],
    );
  });
});
