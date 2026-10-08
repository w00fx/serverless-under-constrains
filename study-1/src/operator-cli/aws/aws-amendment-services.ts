// Wiring only (design §15.4: excluded from the mutation targets): the AWS-bound services behind the
// commands that act on a finalized package:
// - `recover`: `recoverExecution` with cleanup adapters bound to the request's discovery targets
//   (the package's own frozen resource manifest), the lease store of the frozen coordination table,
//   and a safety clock whose total target runs from the start of the recovery;
// - `late-evidence assess`: `assessLateEvidenceAmendment`, with CMP-03's late capture readers over
//   the execution's tables only when the command asks for a re-capture.

import { bindAwsCleanupPorts } from '../../cleanup/aws/aws-cleanup-bindings.ts';
import { createCleanupAwsClients } from '../../cleanup/aws/cleanup-aws-clients.ts';
import { createDurableLeaseStore } from '../../coordination-lease/durable-lease-store.ts';
import {
  createCollectorLambdaClient,
  createLambdaDurableExecutionReader,
} from '../../evidence-collection/aws/durable-execution-reader.ts';
import {
  createCollectorSqsClient,
  createSqsDlqReceiver,
  createSqsQueueCounterReader,
} from '../../evidence-collection/aws/sqs-collector.ts';
import { NodePackageFileSystem } from '../../evidence-package/node/node-package-file-system.ts';
import { assessLateEvidenceAmendment } from '../../execution-lifecycle/late-evidence-amendment.ts';
import { recoverExecution } from '../../execution-lifecycle/operational-recovery.ts';
import { err } from '../../record-contract/primitives.ts';
import type { RecordValidator } from '../../record-contract/schema-registry.ts';
import { safetyLimitsFor } from '../../safety/safety-limits.ts';
import { SafetySupervisor } from '../../safety/safety-supervisor.ts';
import { executionTables } from '../execution-tables.ts';
import type { LateEvidenceLauncher } from '../late-evidence-command.ts';
import { processServices } from '../node/process-services.ts';
import type { RecoveryLauncher } from '../recover-command.ts';
import { cleanupBindings } from './aws-execution-session.ts';
import { createBoundedItemStore } from './aws-execution-store.ts';

/**
 * `recover` over AWS.
 *
 * @example
 * new RecoverCommand({ files, validator, recover: createAwsRecoveryLauncher(validator) });
 */
export function createAwsRecoveryLauncher(validator: RecordValidator): RecoveryLauncher {
  return async (request) => {
    const tables = executionTables(request.admitted);
    if (!tables.ok) {
      return err([tables.error]);
    }
    const services = processServices(validator);
    const store = createBoundedItemStore(tables.value);
    const clients = createCleanupAwsClients();
    const sqs = createCollectorSqsClient();
    return recoverExecution(request.admitted, {
      files: new NodePackageFileSystem(request.evidence_root),
      lease: createDurableLeaseStore(store),
      cleanup: cleanupBindings(clients, store, bindAwsCleanupPorts(clients, request.targets), services),
      readers: {
        store,
        queues: createSqsQueueCounterReader(sqs),
        durable: createLambdaDurableExecutionReader(createCollectorLambdaClient()),
        dlq: createSqsDlqReceiver(sqs),
      },
      safety: new SafetySupervisor({
        monotonic: services.monotonic,
        wall: services.clock,
        limits: safetyLimitsFor(request.admitted.identity.execution_kind),
        startedNs: services.monotonic.nowNs(),
      }),
      services,
    });
  };
}

/**
 * `late-evidence assess` over AWS.
 *
 * @example
 * new LateEvidenceAssessCommand({ files, validator, assess: createAwsLateEvidenceLauncher(validator) });
 */
export function createAwsLateEvidenceLauncher(validator: RecordValidator): LateEvidenceLauncher {
  return async (request) => {
    const services = processServices(validator);
    const files = new NodePackageFileSystem(request.evidence_root);
    if (!request.capture) {
      return assessLateEvidenceAmendment(request.admitted, { files, services });
    }
    const tables = executionTables(request.admitted);
    if (!tables.ok) {
      return err([tables.error]);
    }
    const sqs = createCollectorSqsClient();
    return assessLateEvidenceAmendment(request.admitted, {
      files,
      services,
      capture: {
        store: createBoundedItemStore(tables.value),
        dlq: createSqsDlqReceiver(sqs),
        durable: createLambdaDurableExecutionReader(createCollectorLambdaClient()),
      },
    });
  };
}
