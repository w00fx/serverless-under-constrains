// Hostile values for the fuzz targets of the runner's AWS result mapping (Owner amendment A-05):
// members that throw when read, proxies whose every trap throws, members inherited from a
// prototype instead of owned, and arbitrary values of any type in any member.

import fc from 'fast-check';

/** An object whose `key` throws when read. */
export function throwingMember(key: string): object {
  return withThrowingMember({}, key);
}

/** `target`, given an own `key` that throws when read. */
export function withThrowingMember<T extends object>(target: T, key: string): T {
  return Object.defineProperty(target, key, {
    enumerable: true,
    get(): never {
      throw new Error(`hostile getter ${key}`);
    },
  });
}

/**
 * A proxy over `target` whose traps throw for every string member, its key list and its
 * prototype. Symbol members still answer, so fast-check can look for its clone and print hooks.
 */
export function throwingProxy<T extends object>(target: T): T {
  const refuse = (): never => {
    throw new Error('hostile proxy trap');
  };
  const refuseString =
    <R>(answer: (key: symbol) => R) =>
    (_: T, key: string | symbol): R =>
      typeof key === 'symbol' ? answer(key) : refuse();
  return new Proxy(target, {
    get: refuseString((key) => Reflect.get(target, key)),
    has: refuseString((key) => Reflect.has(target, key)),
    getOwnPropertyDescriptor: refuseString((key) => Reflect.getOwnPropertyDescriptor(target, key)),
    ownKeys: refuse,
    getPrototypeOf: refuse,
  });
}

/** An object that inherits `members` from its prototype and owns none of them. */
export function inheriting(members: Readonly<Record<string, unknown>>): object {
  return Object.create(members) as object;
}

/** Any value, from plain JSON to functions, symbols, big integers and the hostile shapes. */
export const anyValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.anything({ withBigInt: true, withDate: true, withMap: true, withSet: true, withTypedArray: true }),
  fc.constantFrom<unknown>(undefined, null, Number.NaN, Infinity, -0, Symbol('s'), () => 1),
  fc.string({ maxLength: 8 }).map(throwingMember),
  fc.constant(throwingProxy({})),
);
