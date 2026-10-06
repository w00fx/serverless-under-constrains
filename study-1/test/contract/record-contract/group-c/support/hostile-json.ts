// Hostile values that `JSON.parse` accepts and that the group-C validator must judge without
// throwing (Owner amendment A-05): member names every plain object inherits (A-07) and
// non-finite numbers. Shared by the deterministic totality cases and the mutation property.

/**
 * Names every plain object inherits from `Object.prototype`. A schema that tracks evaluated
 * members in a plain object counts them as evaluated (A-07), so each one is a regression case.
 */
export const INHERITED_MEMBER_NAMES: readonly string[] = [
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
];

/**
 * `JSON.parse('1e400')` and `JSON.parse('-1e400')`: the non-finite numbers JSON text can carry,
 * as the Lambda Node runtime decodes them.
 */
export const NON_FINITE_NUMBERS: readonly number[] = [JSON.parse('1e400') as number, JSON.parse('-1e400') as number];
