// The one way this study builds a DynamoDB client (design §9.4): `maxAttempts: 1` overrides
// `AWS_MAX_ATTEMPTS` and the SDK's default retry strategy, so a timed-out write is never
// silently re-sent and every retry decision stays explicit in the callers (BR-RUA-033).

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';

export const STORE_DYNAMODB_CLIENT_OPTIONS = { region: 'us-east-1', maxAttempts: 1 } as const;
const PINNED_SETTING_NAMES: ReadonlySet<string> = new Set(['region', 'maxAttempts', 'retryStrategy', 'retryMode']);

/** Client settings a caller may supply; region and retry behavior are fixed. */
export type StoreClientSettings = Omit<DynamoDBClientConfig, 'region' | 'maxAttempts' | 'retryStrategy' | 'retryMode'>;

/**
 * Builds the DynamoDB client every store adapter uses. Tests pass a recording
 * `requestHandler` and static credentials; production passes nothing.
 *
 * @example
 * const store = createDynamoDbItemStore(tables, createStoreDynamoDbClient());
 */
export function createStoreDynamoDbClient(settings: StoreClientSettings = {}): DynamoDBClient {
  // The type omits the pinned keys, but a cast can still smuggle them in. A smuggled
  // `retryStrategy` would bring retries back while `maxAttempts` still reads 1, so every pinned
  // key is dropped at runtime as well (WP-04 review round 1).
  const allowed = Object.fromEntries(Object.entries(settings).filter(([name]) => !PINNED_SETTING_NAMES.has(name)));
  return new DynamoDBClient({ ...(allowed as StoreClientSettings), ...STORE_DYNAMODB_CLIENT_OPTIONS });
}
