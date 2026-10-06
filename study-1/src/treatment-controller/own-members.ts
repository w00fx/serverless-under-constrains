// Own-member reads of the controller's untrusted parsed objects (Owner amendment A-05): a stream
// record, a stream image and a control item are data, so a member the object does not own, such
// as `constructor` or one a polluted `Object.prototype` adds, is never read as one of its fields.
// WP-08 single-pass review: `readCallerTimeout` accepted an image whose `source` was inherited.

/**
 * The value of an own property of a parsed object, or `undefined`.
 *
 * @example
 * ownMember({ Records: [] }, 'Records'); // []
 * ownMember({}, 'constructor'); // undefined
 */
export function ownMember(object: Readonly<Record<string, unknown>>, name: string): unknown {
  return Object.hasOwn(object, name) ? object[name] : undefined;
}

/**
 * A null-prototype copy of an object's own enumerable members, so every later read of a field
 * sees only what the object itself carries. An own `__proto__` member stays a plain member.
 *
 * @example
 * ownMembers(JSON.parse('{"__proto__":1}'))['__proto__']; // 1
 * ownMembers({ a: 1 })['toString']; // undefined
 */
export function ownMembers<T extends object>(object: T): T {
  const copy = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(object)) {
    copy[name] = value;
  }
  return copy as T;
}
