// Describes a value the controller read from untrusted input (a stream image or a control item)
// for an error message, without recursion. The kernel's `describeJson` serializes the whole value
// with `JSON.stringify`, which recurses natively and throws RangeError on nesting deeper than the
// call stack (WP-08 review r1), so a reason could become an exception. Here only scalars are
// shown, a long string is cut, and a container is named by its size.
//
// The probe caller has a twin (`transport-probe-caller/payload-value.ts`) because design §5.4
// forbids it to import this feature; a kernel-level replacement belongs to a record-contract
// chore package.

const STRING_PREVIEW_LIMIT = 64;

/**
 * Names the JSON type of `value` and, for a scalar, its value; never throws.
 *
 * @example
 * describeUntrustedValue('ABC'); // 'string "ABC"'
 * describeUntrustedValue(undefined); // 'absent'
 * describeUntrustedValue([[[]]]); // 'array of length 1'
 */
export function describeUntrustedValue(value: unknown): string {
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
    return `string ${previewString(value)}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${typeof value} ${String(value)}`;
  }
  if (typeof value === 'object') {
    return `object with ${String(Object.keys(value).length)} member(s)`;
  }
  return typeof value;
}

function previewString(value: string): string {
  if (value.length <= STRING_PREVIEW_LIMIT) {
    return JSON.stringify(value);
  }
  return `${JSON.stringify(value.slice(0, STRING_PREVIEW_LIMIT))}… (${String(value.length)} characters)`;
}
