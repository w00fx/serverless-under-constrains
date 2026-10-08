// Asserts a thrown AWS SDK service exception by its name, fault, HTTP status and request id, the
// members send-failure-classification.ts reads, without pinning the SDK's other metadata.

import assert from 'node:assert/strict';

/**
 * A validator for `assert.rejects`: the service exception's name, fault, HTTP status and (when
 * given) request id.
 *
 * @example
 * await assert.rejects(client.send(command), serviceException('QueueDoesNotExist', 'client', 400));
 */
export function serviceException(
  name: string,
  fault: string,
  status: number,
  requestId?: string,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    const exception = error as {
      readonly name?: unknown;
      readonly $fault?: unknown;
      readonly $metadata?: Record<string, unknown>;
    };
    assert.equal(exception.name, name);
    assert.equal(exception.$fault, fault);
    assert.equal(exception.$metadata?.['httpStatusCode'], status);
    if (requestId !== undefined) {
      assert.equal(exception.$metadata['requestId'], requestId);
    }
    return true;
  };
}
