// Digest links between golden fixture files (and one text link, for a captured message body). A record that names another file's bytes (the trial
// manifest's payment digest, every event's `trial_manifest_sha256`, the published message's
// SHA-256 and MD5) holds a link such as `@sha256(trials/<t>/trial-manifest.json)` until the files
// are serialized. Serialization then writes files in dependency order and replaces each link with
// the lowercase digest of the exact stored bytes (BR-RUA-033). A scenario operation that edits a
// linked file therefore keeps every reference consistent, while a literal digest written by a case
// stays as written: that is how a case states a core-file digest mismatch on purpose.

import { createHash } from 'node:crypto';

import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import type { JsonValue, Result, Sha256Hex } from '../../../src/record-contract/primitives.ts';

/** One fixture file before serialization: a single record, or JSONL lines. */
export type FixtureFileContent =
  | { readonly kind: 'json'; readonly record: JsonValue }
  | { readonly kind: 'jsonl'; readonly records: readonly JsonValue[] };

/** Package-relative path to content, before links are resolved. */
export type ScenarioFiles = ReadonlyMap<string, FixtureFileContent>;

/** Package-relative path to exact bytes. */
export type FixtureBytes = ReadonlyMap<string, Uint8Array>;

const LINK_PATTERN = /^@(sha256|md5|text)\(([^()]+)\)$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A link to the SHA-256 of another fixture file's bytes, typed as the digest it becomes.
 *
 * @example
 * linkSha256('admission/execution-manifest.json'); // '@sha256(admission/execution-manifest.json)'
 */
export function linkSha256(path: string): Sha256Hex {
  return `@sha256(${path})` as Sha256Hex;
}

/**
 * A link to the MD5 of another fixture file's bytes (the SQS `MD5OfMessageBody`).
 *
 * @example
 * linkMd5('trials/t/inputs/published-message.json'); // '@md5(trials/t/inputs/published-message.json)'
 */
export function linkMd5(path: string): string {
  return `@md5(${path})`;
}

/**
 * A link to the UTF-8 text of another fixture file: the body of the SQS message a DLQ snapshot
 * captures is the exact text of `inputs/published-message.json`.
 *
 * @example
 * linkText('trials/t/inputs/published-message.json'); // '@text(trials/t/inputs/published-message.json)'
 */
export function linkText(path: string): string {
  return `@text(${path})`;
}

/**
 * Serializes every file canonically (one record plus a newline, or one canonical line per JSONL
 * record), resolving digest links in dependency order. Fails, listing every problem, when a link
 * names a file the scenario does not hold or when links form a cycle.
 *
 * @example
 * const bytes = serializeScenarioFiles(files);
 * if (bytes.ok) bytes.value.get('trials/t/trial-manifest.json');
 */
export function serializeScenarioFiles(files: ScenarioFiles): Result<FixtureBytes, readonly string[]> {
  const resolver = new LinkResolver(files);
  const serialized = new Map<string, Uint8Array>();
  const problems: string[] = [];
  for (const path of [...files.keys()].sort()) {
    const bytes = resolver.bytesOf(path, []);
    if (bytes.ok) {
      serialized.set(path, bytes.value);
    } else {
      problems.push(bytes.error);
    }
  }
  return problems.length === 0 ? { ok: true, value: serialized } : { ok: false, error: [...new Set(problems)] };
}

class LinkResolver {
  readonly #files: ScenarioFiles;
  readonly #done = new Map<string, Result<Uint8Array, string>>();

  constructor(files: ScenarioFiles) {
    this.#files = files;
  }

  bytesOf(path: string, chain: readonly string[]): Result<Uint8Array, string> {
    const known = this.#done.get(path);
    if (known !== undefined) {
      return known;
    }
    if (chain.includes(path)) {
      return { ok: false, error: `digest links form a cycle ${[...chain, path].join(' -> ')}; expected acyclic links` };
    }
    const content = this.#files.get(path);
    if (content === undefined) {
      return {
        ok: false,
        error: `a digest link names ${JSON.stringify(path)}, which the scenario does not hold; expected a fixture file path`,
      };
    }
    const resolved = this.#encode(content, [...chain, path]);
    this.#done.set(path, resolved);
    return resolved;
  }

  #encode(content: FixtureFileContent, chain: readonly string[]): Result<Uint8Array, string> {
    const values = content.kind === 'json' ? [content.record] : content.records;
    let failure: string | undefined;
    const lines = values.map((value) =>
      canonicalJson(
        mapStrings(value, (text) => {
          const link = this.#resolveLink(text, chain);
          failure ??= link.ok ? undefined : link.error;
          return link.ok ? link.value : text;
        }),
      ),
    );
    if (failure !== undefined) {
      return { ok: false, error: failure };
    }
    return { ok: true, value: encoder.encode(lines.map((line) => `${line}\n`).join('')) };
  }

  #resolveLink(text: string, chain: readonly string[]): Result<string, string> {
    const match = LINK_PATTERN.exec(text);
    if (match === null) {
      return { ok: true, value: text };
    }
    const [, kind = 'text', target = ''] = match;
    const bytes = this.bytesOf(target, chain);
    if (!bytes.ok) {
      return bytes;
    }
    const value = kind === 'text' ? decoder.decode(bytes.value) : createHash(kind).update(bytes.value).digest('hex');
    return { ok: true, value };
  }
}

/**
 * A copy of a JSON value with every string passed through `map`. Iterative, so a value nested past
 * the call stack is copied rather than overflowing it (Owner amendment A-05). Members are defined,
 * never assigned, so a member named `__proto__` stays an own property.
 *
 * @example
 * mapStrings({ a: ['x'] }, (text) => text.toUpperCase()); // { a: ['X'] }
 */
export function mapStrings(value: JsonValue, map: (text: string) => string): JsonValue {
  const root: { value: JsonValue } = { value: null };
  const pending: PendingCopy[] = [
    [
      value,
      (copy: JsonValue): void => {
        root.value = copy;
      },
    ],
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [current, assign] = next;
    assign(typeof current === 'string' ? map(current) : shallowCopy(current, pending));
  }
  return root.value;
}

/** A value still to copy, and where its copy goes. */
type PendingCopy = readonly [JsonValue, (copy: JsonValue) => void];

// A container becomes an empty copy whose members are queued; any other value is its own copy.
function shallowCopy(current: JsonValue, pending: PendingCopy[]): JsonValue {
  if (Array.isArray(current)) {
    const copy: JsonValue[] = [];
    (current as readonly JsonValue[]).forEach((item, index) => {
      pending.push([
        item,
        (child: JsonValue): void => {
          copy[index] = child;
        },
      ]);
    });
    return copy;
  }
  if (current === null || typeof current !== 'object') {
    return current;
  }
  const copy: Record<string, JsonValue> = {};
  // Queued last-first, so members are defined in their original order as the stack pops them.
  for (const [key, member] of Object.entries(current).toReversed()) {
    pending.push([
      member,
      (child: JsonValue): void => {
        defineMember(copy, key, child);
      },
    ]);
  }
  return copy;
}

/**
 * Defines an own enumerable member, also for names such as `__proto__` that assignment would
 * route to the prototype.
 *
 * @example
 * defineMember(target, '__proto__', 1); // Object.hasOwn(target, '__proto__') === true
 */
export function defineMember(target: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
