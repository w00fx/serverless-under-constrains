// Lockfile bytes shared by the parsePackageLock unit cases and its property
// (test/fuzz/transport-qualification/scope/package-lock.fuzz.test.ts, Owner amendment A-11).

const encoder = new TextEncoder();

/**
 * The UTF-8 bytes of a document serialized as JSON, as a lockfile reader receives them.
 *
 * @example
 * parsePackageLock(lockBytes({ lockfileVersion: 3, packages: {} }));
 */
export function lockBytes(document: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(document));
}
