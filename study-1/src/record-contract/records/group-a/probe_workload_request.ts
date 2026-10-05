// `probe_workload_request` (BR-RUA-027): the payload of the runner's single synchronous
// invocation of the probe caller, which performs exactly one refund attempt.

import type { Sha256Hex, Uuid4 } from '../../primitives.ts';

export interface ProbeWorkloadRequest {
  readonly schema_version: 1;
  readonly record_type: 'probe_workload_request';
  readonly transport_probe_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly payment_id: string;
  readonly refund_request_id: string;
  readonly amount_minor: number;
  readonly currency: 'BRL';
}
