// The P9 summary writer of each execution kind (design §10.2; CTR-RUA-002, CTR-RUA-003,
// BR-RUA-038): a run writes the comparison assessment and the run summary, a probe the transport
// probe summary, and a validation the validation summary.

import type { ExecutionKind } from '../record-contract/primitives.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { RunSummaryWriter } from './execution-finalization.ts';
import type { SummaryWriter } from './execution-finalization.ts';
import { TransportProbeSummaryWriter } from './probe-summary-writer.ts';
import { ValidationSummaryWriter } from './validation-summary-writer.ts';

/**
 * The summary writer bound to `kind`.
 *
 * @example
 * const summary = summaryWriterFor(admitted.identity.execution_kind, validator);
 */
export function summaryWriterFor(kind: ExecutionKind, validator: RecordValidator): SummaryWriter {
  switch (kind) {
    case 'RUN':
      return new RunSummaryWriter(validator);
    case 'TRANSPORT_PROBE':
      return new TransportProbeSummaryWriter(validator);
    case 'VARIANT_VALIDATION':
      return new ValidationSummaryWriter(validator);
  }
}
