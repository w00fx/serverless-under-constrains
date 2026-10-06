// One iterative JSON text writer shared by the canonical serializer (BR-RUA-033) and the
// bounded value renderer of error details. It keeps its own work stack instead of recursing:
// JSON.parse accepts nesting far deeper than the call stack (parsing.ts), and every value it
// returns is untrusted input that the kernel must handle without a RangeError (Owner amendment
// A-02; WP-00 review round 1 measured a crash near 2,500 levels, about 10 KB of input).

/** How the writer spells leaves and keys, orders members and decides what an object is. */
export interface JsonTextStyle {
  /** Sorts object keys by UTF-16 code units (canonical form) instead of insertion order. */
  readonly sortKeys: boolean;
  /** Text of a value that is not walked as a container, or `undefined` when it has no JSON text. */
  readonly leafText: (value: unknown) => string | undefined;
  /** Text of an object key, quotes included. */
  readonly keyText: (key: string) => string;
  /** Whether a non-array object is walked as a JSON object; `false` makes it a leaf. */
  readonly isWalkedObject: (value: object) => boolean;
}

/** Where the walk stopped on a value with no JSON text, as `$`, `$.a` or `$.a[0]`. */
export interface JsonTextGap {
  readonly path: string;
  readonly value: unknown;
}

/** A value the walk still has to write; boxed because the value itself may be `undefined`. */
interface PendingValue {
  readonly value: unknown;
}

/** A member of a container: its array index or object key, and its value. */
type Member = readonly [string | number, unknown];

interface ContainerFrame {
  readonly close: string;
  readonly members: Iterator<Member, undefined>;
  /** The member being written (an index or a key); `undefined` before the first one. */
  position: string | number | undefined;
}

/**
 * Yields the JSON text of `value` in pieces, depth first, without recursion. The return value
 * is `undefined` after a complete walk, or the first gap: a value `style.leafText` cannot spell.
 * A consumer may stop early, which keeps the work bounded for huge values.
 *
 * @example
 * const pieces = jsonTextPieces({ b: 1, a: [true] }, canonicalStyle);
 * [...pieces].join(''); // '{"a":[true],"b":1}'
 */
export function* jsonTextPieces(value: unknown, style: JsonTextStyle): Generator<string, JsonTextGap | undefined> {
  const stack: ContainerFrame[] = [];
  const rootGap = yield* writeValue(value, stack, style);
  if (rootGap !== undefined) {
    return rootGap;
  }
  for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
    const child = yield* advance(frame, stack, style);
    const gap = child === undefined ? undefined : yield* writeValue(child.value, stack, style);
    if (gap !== undefined) {
      return gap;
    }
  }
  return undefined;
}

// Writes a leaf, or opens a container and pushes its frame; a value with no text is a gap.
function* writeValue(
  value: unknown,
  stack: ContainerFrame[],
  style: JsonTextStyle,
): Generator<string, JsonTextGap | undefined> {
  const opened = openValue(value, style);
  if (opened === undefined) {
    return { path: pathOf(stack), value };
  }
  yield opened.open;
  if (opened.frame !== undefined) {
    stack.push(opened.frame);
  }
  return undefined;
}

// Closes the innermost finished container, or yields the separator before its next member
// and returns that member for the walk to write.
function* advance(
  frame: ContainerFrame,
  stack: ContainerFrame[],
  style: JsonTextStyle,
): Generator<string, PendingValue | undefined> {
  const step = frame.members.next();
  if (step.done === true) {
    stack.pop();
    yield frame.close;
    return undefined;
  }
  const [position, child] = step.value;
  const separator = frame.position === undefined ? '' : ',';
  frame.position = position;
  yield typeof position === 'number' ? separator : `${separator}${style.keyText(position)}:`;
  return { value: child };
}

function openValue(
  value: unknown,
  style: JsonTextStyle,
): { readonly open: string; readonly frame: ContainerFrame | undefined } | undefined {
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return { open: '[', frame: { close: ']', members: items.entries(), position: undefined } };
  }
  if (typeof value === 'object' && value !== null && style.isWalkedObject(value)) {
    const members = value as Readonly<Record<string, unknown>>;
    const keys = style.sortKeys ? Object.keys(members).sort() : Object.keys(members);
    return { open: '{', frame: { close: '}', members: objectMembers(members, keys), position: undefined } };
  }
  const text = style.leafText(value);
  return text === undefined ? undefined : { open: text, frame: undefined };
}

function* objectMembers(
  members: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Generator<Member, undefined> {
  for (const key of keys) {
    yield [key, members[key]];
  }
  return undefined;
}

function pathOf(stack: readonly ContainerFrame[]): string {
  const steps = stack.map(({ position }) =>
    typeof position === 'number' ? `[${String(position)}]` : `.${String(position)}`,
  );
  return `$${steps.join('')}`;
}
