// Stack-safe array appends for the durable-store walkers (pure, a mutation target).
//
// `target.push(...items)` passes every item as a call argument, and V8 throws RangeError
// (Maximum call stack size exceeded) once a call has more than about 100,000 arguments. A
// caller can pass an `all` condition that wide, or a value whose list yields that many
// violations, so the walkers and validators append one item per call instead (WP-04 review
// round 2: a 100,000-member `all` made validateWriteAction, toConditionExpression and
// planWrite throw).

/**
 * Appends every item to `target`, in order, one `push` call per item.
 *
 * @example
 * const stack: Condition[] = [];
 * pushEach(stack, wide.conditions); // safe for any width
 */
export function pushEach<T>(target: T[], items: readonly T[]): void {
  for (const item of items) {
    target.push(item);
  }
}
