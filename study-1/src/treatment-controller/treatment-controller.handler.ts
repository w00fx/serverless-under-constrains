// Lambda entry of the treatment controller (design §9.4: DynamoDB stream ESM on the caller
// journal, 30 s timeout). Clients are created lazily on the first invocation. Each handled
// record gets a new journal source instance through the composition. Log lines are JSON on
// stdout; a ControllerFault fails the invocation so the mapping retries within its bound (§9.5).

import { createStoreDynamoDbClient } from '../durable-store/aws/dynamodb-client.ts';
import { createDynamoDbItemStore } from '../durable-store/aws/dynamodb-item-store.ts';
import { composeTreatmentController } from './controller-composition.ts';
import { parseControllerEnvironment } from './controller-environment.ts';
import { controllerSystemRuntime } from './node/system-runtime.ts';
import type { ControllerLogLine } from './stream-consumer.ts';
import { consumeStreamEvent } from './stream-consumer.ts';
import type { TreatmentController } from './treatment-controller.ts';

let controller: TreatmentController | undefined;

function controllerInstance(): TreatmentController {
  if (controller !== undefined) {
    return controller;
  }
  const environment = parseControllerEnvironment(process.env);
  if (!environment.ok) {
    throw new Error(environment.error);
  }
  const store = createDynamoDbItemStore(environment.value.tables, createStoreDynamoDbClient());
  controller = composeTreatmentController({
    deployment: environment.value.deployment,
    store,
    ...controllerSystemRuntime(),
  });
  return controller;
}

function writeLog(line: ControllerLogLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// A composition failure (for example a missing environment variable) happens before the
// consumer runs, so it is logged here as one JSON line before it fails the invocation.
function loggedControllerInstance(): TreatmentController {
  try {
    return controllerInstance();
  } catch (error) {
    writeLog({ level: 'error', event: 'controller_error', detail: String(error) });
    throw error;
  }
}

/**
 * The Lambda entry: consumes one DynamoDB stream event of the caller journal.
 *
 * @example
 * await handler({ Records: [streamRecord] }); // one JSON log line per record on stdout
 */
export async function handler(event: unknown): Promise<void> {
  await consumeStreamEvent(event, loggedControllerInstance(), writeLog);
}
