// Cursor text helpers shared by the page-cursor unit cases and the page-cursor fuzz properties
// (Owner amendment A-11 moved the properties to test/fuzz/durable-store/).

/**
 * The base64url text of a UTF-8 string, the encoding a page cursor carries.
 *
 * @example
 * base64url('{"pk":"p","sk":"s"}'); // 'eyJwayI6InAiLCJzayI6InMifQ'
 */
export function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

// No refusal may grow with the cursor (Owner amendment A-05): the cursor is named by its length
// and decoded strings are quoted through the kernel's 200-character bound.
export const MAX_ERROR_LENGTH = 1_000;
