// Committed per-unit price ceilings for the admission cost estimate (BR-RUA-046, design D-19).
// Each value is the highest (first-tier, no free tier) on-demand price of US East (N. Virginia)
// read from the AWS pricing page named beside it on the retrieval date. A ceiling that is higher
// than the page keeps the estimate conservative: CloudWatch Logs is priced per MB at USD 0.50
// per 1,000 MB, above the page's USD 0.50 per GB.
//
// Source note: the SQS page did not render its table to the fetch on 2026-10-06; the FIFO and
// standard first-tier prices come from the AWS SQS pricing announcements and page summary
// (search of aws.amazon.com, same date) and are marked `UNVERIFIED` until an operator confirms
// them against the live table (D-19).

import type { MoneyDecimal } from '../record-contract/primitives.ts';

/** The metered usage a conservative execution plan states. */
export const PRICE_METERS = [
  'lambda_requests',
  'lambda_gb_seconds',
  'lambda_durable_operations',
  'dynamodb_write_request_units',
  'dynamodb_read_request_units',
  'dynamodb_stream_read_request_units',
  'sqs_fifo_requests',
  'sqs_standard_requests',
  'cloudwatch_logs_ingested_mb',
] as const;
export type PriceMeter = (typeof PRICE_METERS)[number];

export interface PriceCeiling {
  readonly meter: PriceMeter;
  /** One unit of the meter, in words. */
  readonly unit: string;
  readonly usd_per_unit: MoneyDecimal;
  readonly source_url: string;
  /** `YYYY-MM-DD` of the reading. */
  readonly retrieved_on: string;
  /** `verified` when the number was read from the page itself. */
  readonly source_status: 'verified' | 'UNVERIFIED';
}

export type PriceCeilingTable = readonly PriceCeiling[];

const RETRIEVED_ON = '2026-10-06';
const LAMBDA_PAGE = 'https://aws.amazon.com/lambda/pricing/';
const DYNAMODB_PAGE = 'https://aws.amazon.com/dynamodb/pricing/on-demand/';
const SQS_PAGE = 'https://aws.amazon.com/sqs/pricing/';
const CLOUDWATCH_PAGE = 'https://aws.amazon.com/cloudwatch/pricing/';

function ceiling(
  meter: PriceMeter,
  unit: string,
  usdPerUnit: string,
  sourceUrl: string,
  status: PriceCeiling['source_status'] = 'verified',
): PriceCeiling {
  return {
    meter,
    unit,
    usd_per_unit: usdPerUnit as MoneyDecimal,
    source_url: sourceUrl,
    retrieved_on: RETRIEVED_ON,
    source_status: status,
  };
}

/** The committed ceilings, one per meter, in `PRICE_METERS` order. */
export const PRICE_CEILINGS: PriceCeilingTable = [
  // USD 0.20 per 1M requests.
  ceiling('lambda_requests', 'request', '0.0000002', LAMBDA_PAGE),
  // USD 0.0000166667 per GB-second, x86, first tier.
  ceiling('lambda_gb_seconds', 'GB-second', '0.0000166667', LAMBDA_PAGE),
  // Durable functions: USD 8.00 per 1M durable operations.
  ceiling('lambda_durable_operations', 'durable operation', '0.000008', LAMBDA_PAGE),
  // On-demand: USD 0.625 per 1M write request units.
  ceiling('dynamodb_write_request_units', 'write request unit', '0.000000625', DYNAMODB_PAGE),
  // On-demand: USD 0.125 per 1M read request units.
  ceiling('dynamodb_read_request_units', 'read request unit', '0.000000125', DYNAMODB_PAGE),
  // Streams: USD 0.02 per 100,000 read request units.
  ceiling('dynamodb_stream_read_request_units', 'stream read request unit', '0.0000002', DYNAMODB_PAGE),
  // FIFO: USD 0.50 per 1M requests, first tier.
  ceiling('sqs_fifo_requests', 'request', '0.0000005', SQS_PAGE, 'UNVERIFIED'),
  // Standard: USD 0.40 per 1M requests, first tier.
  ceiling('sqs_standard_requests', 'request', '0.0000004', SQS_PAGE, 'UNVERIFIED'),
  // Standard log class ingestion: USD 0.50 per GB, charged here per 1,000 MB.
  ceiling('cloudwatch_logs_ingested_mb', 'MB ingested', '0.0005', CLOUDWATCH_PAGE),
];
