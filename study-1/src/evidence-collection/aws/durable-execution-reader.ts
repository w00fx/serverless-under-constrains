// Lambda binding of the collector's `DurableExecutionReader` (design §5.3; BR-RUA-020, RK-10).
// Thin by construction: each call sends one ListDurableExecutionsByFunction,
// GetDurableExecution or GetDurableExecutionHistory request and returns the service page as is;
// paging and mapping live in `durable-metadata.ts` and `durable-sdk-mapping.ts`. The client is
// built with `maxAttempts: 1` so every retry decision stays with the collector.

import {
  GetDurableExecutionCommand,
  GetDurableExecutionHistoryCommand,
  LambdaClient,
  ListDurableExecutionsByFunctionCommand,
} from '@aws-sdk/client-lambda';
import type { LambdaClientConfig } from '@aws-sdk/client-lambda';

import type { DurableExecutionReader } from '../durable-metadata.ts';
import { settleSdkCall } from '../sdk-values.ts';

export const COLLECTOR_LAMBDA_CLIENT_OPTIONS = { region: 'us-east-1', maxAttempts: 1 } as const;
const PINNED_SETTING_NAMES: ReadonlySet<string> = new Set(['region', 'maxAttempts', 'retryStrategy', 'retryMode']);

/** Client settings a caller may supply; region and retry behavior are fixed. */
export type CollectorLambdaClientSettings = Omit<
  LambdaClientConfig,
  'region' | 'maxAttempts' | 'retryStrategy' | 'retryMode'
>;

/**
 * Builds the Lambda client of the collector. Tests pass a scripted `requestHandler` and static
 * credentials; production passes nothing.
 *
 * @example
 * const reader = createLambdaDurableExecutionReader(createCollectorLambdaClient());
 */
export function createCollectorLambdaClient(settings: CollectorLambdaClientSettings = {}): LambdaClient {
  // A cast can smuggle a pinned key past the type, so pinned keys are dropped at run time too.
  const allowed = Object.fromEntries(Object.entries(settings).filter(([name]) => !PINNED_SETTING_NAMES.has(name)));
  return new LambdaClient({ ...(allowed as CollectorLambdaClientSettings), ...COLLECTOR_LAMBDA_CLIENT_OPTIONS });
}

/**
 * The three durable-execution reads, one service page per call.
 *
 * @example
 * await createLambdaDurableExecutionReader(client).listPage(request); // { ok: true, value: { DurableExecutions: [...] } }
 */
export function createLambdaDurableExecutionReader(client: LambdaClient): DurableExecutionReader {
  return {
    listPage: (request, marker) =>
      settleSdkCall(() =>
        client.send(
          new ListDurableExecutionsByFunctionCommand({
            FunctionName: request.function_arn,
            Qualifier: request.qualifier,
            StartedAfter: new Date(request.started_after),
            ...(marker === undefined ? {} : { Marker: marker }),
          }),
        ),
      ),
    getExecution: (arn) =>
      settleSdkCall(() => client.send(new GetDurableExecutionCommand({ DurableExecutionArn: arn }))),
    historyPage: (arn, marker) =>
      settleSdkCall(() =>
        client.send(
          new GetDurableExecutionHistoryCommand({
            DurableExecutionArn: arn,
            IncludeExecutionData: false,
            ...(marker === undefined ? {} : { Marker: marker }),
          }),
        ),
      ),
  };
}
