// Shared fixtures of the transport-probe-caller tests: the runner's workload request (BR-RUA-027)
// and the identities of the refund-provider fixtures it is built from.

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import {
  MANIFEST_SHA,
  PAYMENT_ID,
  PROBE_ID,
  REFUND_REQUEST_ID,
} from '../../../support/refund-provider/provider-fixtures.ts';

export {
  MANIFEST_SHA,
  OTHER_RUN_ID,
  PAYMENT_ID,
  PROBE,
  PROBE_ID,
  PROBE_PK,
  REFUND_REQUEST_ID,
  RUN,
} from '../../../support/refund-provider/provider-fixtures.ts';

/** A valid `probe_workload_request` for PROBE. */
export function workloadRequest(overrides: JsonObject = {}): JsonObject {
  return {
    schema_version: 1,
    record_type: 'probe_workload_request',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    payment_id: PAYMENT_ID,
    refund_request_id: REFUND_REQUEST_ID,
    amount_minor: 10000,
    currency: 'BRL',
    ...overrides,
  };
}
