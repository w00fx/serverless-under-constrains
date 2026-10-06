// Describes a value of the runner's invocation payload for a refusal, without recursion. The
// payload is untrusted JSON that Lambda parses for us, so it may nest far deeper than the call
// stack allows; the kernel's `describeJson` serializes it with `JSON.stringify`, which recurses
// natively and threw RangeError at about 6,200 levels (WP-08 review r1). Only scalars are shown,
// a long string is cut, and a container is named by its size.
//
// The treatment controller has a twin (`treatment-controller/untrusted-value.ts`); design §5.4
// forbids this feature to import it, and a kernel-level replacement belongs to a
// record-contract chore package.

const PAYLOAD_PREVIEW_LIMIT = 64;

/**
 * Names the JSON type of `value` and, for a scalar, its value; never throws.
 *
 * @example
 * describePayloadValue(7); // 'number 7'
 * describePayloadValue(undefined); // 'absent'
 * describePayloadValue({ a: { b: {} } }); // 'object with 1 member(s)'
 */
export function describePayloadValue(value: unknown): string {
  if (value === undefined) {
    return 'absent';
  }
  if (value === null) {
    return 'null null';
  }
  if (Array.isArray(value)) {
    return `array of length ${String(value.length)}`;
  }
  if (typeof value === 'string') {
    return `string ${previewPayloadString(value)}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${typeof value} ${String(value)}`;
  }
  if (typeof value === 'object') {
    return `object with ${String(Object.keys(value).length)} member(s)`;
  }
  return typeof value;
}

function previewPayloadString(value: string): string {
  if (value.length <= PAYLOAD_PREVIEW_LIMIT) {
    return JSON.stringify(value);
  }
  return `${JSON.stringify(value.slice(0, PAYLOAD_PREVIEW_LIMIT))}… (${String(value.length)} characters)`;
}
