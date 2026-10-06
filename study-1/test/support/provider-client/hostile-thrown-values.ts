// Values whose name, message or string conversion throws (WP-06 review round 1), shared by the
// transportErrorFromThrown example cases and its property (Owner amendment A-11).

/**
 * A null-prototype object, an object whose toString throws, and Errors whose name or message
 * getter throws.
 *
 * @example
 * hostileThrownValues().map((value) => transportErrorFromThrown(value).error_name); // ['UnrepresentableThrown', ...]
 */
export function hostileThrownValues(): readonly unknown[] {
  const throwingToString = {
    toString: (): string => {
      throw new Error('x');
    },
  };
  const throwingName = new Error('m');
  Object.defineProperty(throwingName, 'name', {
    get: (): string => {
      throw new Error('getter');
    },
  });
  const throwingMessage = new Error('m');
  Object.defineProperty(throwingMessage, 'message', {
    get: (): string => {
      throw new Error('getter');
    },
  });
  return [Object.create(null), throwingToString, throwingName, throwingMessage];
}
