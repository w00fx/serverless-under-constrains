// Lambda binding of `ConsumerControlPort` (BR-RUA-048 step 3, design §10.4): disables an
// event-source mapping with `UpdateEventSourceMapping(Enabled=false)` and reads its `State` with
// `GetEventSourceMapping`. Thin by construction: one request per call, the settled result handed
// to `sdk-call-outcomes.ts`, where a mapping that does not exist reads absent.

import { GetEventSourceMappingCommand, UpdateEventSourceMappingCommand } from '@aws-sdk/client-lambda';
import type { LambdaClient } from '@aws-sdk/client-lambda';

import type { ConsumerControlPort, ConsumerDisableRequest, ConsumerStateRead } from '../cleanup-ports.ts';
import { consumerStateOutcome, disableRequestOutcome, settleCleanupCall } from '../sdk-call-outcomes.ts';

/**
 * Event-source mappings through Lambda.
 *
 * @example
 * const consumers = new LambdaConsumerControl(clients.lambda);
 * await consumers.requestDisable(uuid); // { kind: 'requested' }
 */
export class LambdaConsumerControl implements ConsumerControlPort {
  readonly #lambda: LambdaClient;

  constructor(lambda: LambdaClient) {
    this.#lambda = lambda;
  }

  /** Asks Lambda to disable the mapping; the disable completes asynchronously. */
  async requestDisable(mappingId: string): Promise<ConsumerDisableRequest> {
    const call = await settleCleanupCall(() =>
      this.#lambda.send(new UpdateEventSourceMappingCommand({ UUID: mappingId, Enabled: false })),
    );
    return disableRequestOutcome(call, mappingId);
  }

  /** The mapping's `State` (`Disabled` once the disable completed). */
  async readState(mappingId: string): Promise<ConsumerStateRead> {
    const call = await settleCleanupCall(() =>
      this.#lambda.send(new GetEventSourceMappingCommand({ UUID: mappingId })),
    );
    return consumerStateOutcome(call, mappingId);
  }
}
