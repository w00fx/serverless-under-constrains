// Wiring only (design §15.4: excluded from the mutation targets): the DynamoDB item store of one
// execution, its five run-owned tables and the coordination table, over one client whose every
// request is bounded. The bound keeps a hung coordination write from outliving the 30 s heartbeat
// interval (WP-22 review residual 2): a request that times out rejects, the lease guard turns it
// into an ambiguous write, and the lease session's documented uncertainty path takes over.

import { NodeHttpHandler } from '@smithy/node-http-handler';

import type { StoreTableNames } from '../../durable-store/dynamodb-requests.ts';
import { createStoreDynamoDbClient } from '../../durable-store/aws/dynamodb-client.ts';
import { createDynamoDbItemStore } from '../../durable-store/aws/dynamodb-item-store.ts';
import type { DurableItemStore } from '../../durable-store/item-store-port.ts';

/** The connection bound of every store request, in milliseconds. */
export const STORE_CONNECTION_TIMEOUT_MS = 3_000;
/** The response bound of every store request: well under the 30 s heartbeat interval. */
export const STORE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The item store over `tables`, with bounded requests.
 *
 * @example
 * const store = createBoundedItemStore({ coordination: 'suc-coordination' });
 */
export function createBoundedItemStore(tables: StoreTableNames): DurableItemStore {
  return createDynamoDbItemStore(
    tables,
    createStoreDynamoDbClient({
      requestHandler: new NodeHttpHandler({
        connectionTimeout: STORE_CONNECTION_TIMEOUT_MS,
        requestTimeout: STORE_REQUEST_TIMEOUT_MS,
      }),
    }),
  );
}
