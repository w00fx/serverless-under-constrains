// A total parser of `git status --porcelain=v2 --branch -z` output (BR-RUA-042, design §10.1 A5,
// §12.5). Records are NUL-terminated; a rename or copy (`2`) record is followed by one more
// NUL-terminated field, its original path. Header lines start with `# `. Every other record is
// a changed (`1`), renamed or copied (`2`), unmerged (`u`), untracked (`?`) or ignored (`!`)
// entry. Anything else, or an entry with too few fields, is kept as a malformed record: the
// caller refuses to call such a tree clean, because an unread line may hide a change.
// The parser never throws and reads only own data, so arbitrary text is safe input.

/** The kinds of status entries porcelain v2 reports. */
export type GitStatusEntryKind = 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';

export interface GitStatusEntry {
  readonly kind: GitStatusEntryKind;
  /** The path relative to the repository root, exactly as git printed it. */
  readonly path: string;
  /** The `<sub>` field: `N...` for a regular path, `S<c><m><u>` for a submodule; absent for `?` and `!`. */
  readonly submodule?: string;
}

export interface GitStatusSnapshot {
  /** `# branch.oid`: the HEAD commit, or `undefined` when absent or `(initial)` (no commit yet). */
  readonly commit_sha?: string;
  /** `# branch.head`: the branch, or `undefined` when absent or `(detached)`. */
  readonly branch?: string;
  readonly detached_head: boolean;
  readonly entries: readonly GitStatusEntry[];
  /** Records the parser could not read, kept verbatim. */
  readonly malformed: readonly string[];
}

/** Fields before the path: `1` has 8, `2` has 9 (plus the original path record), `u` has 10. */
const LEADING_FIELDS = { '1': 8, '2': 9, u: 10 } as const;
const ENTRY_KINDS = { '1': 'changed', '2': 'renamed', u: 'unmerged' } as const;
type TrackedMarker = keyof typeof LEADING_FIELDS;

interface ParseState {
  commit_sha: string | undefined;
  branch: string | undefined;
  detached_head: boolean;
  readonly entries: GitStatusEntry[];
  readonly malformed: string[];
}

/**
 * Parses porcelain v2 `-z` output into headers, entries and unreadable records.
 *
 * @example
 * parseGitPorcelainV2('# branch.oid 1f2e…\0# branch.head main\0? notes.txt\0').entries;
 * // [{ kind: 'untracked', path: 'notes.txt' }]
 */
export function parseGitPorcelainV2(output: string): GitStatusSnapshot {
  const records = output.split('\0');
  // `-z` terminates every record, so the text after the last NUL must be empty.
  // `split` always yields at least one element, so `pop` always returns a string.
  const trailing = String(records.pop());
  const state: ParseState = {
    commit_sha: undefined,
    branch: undefined,
    detached_head: false,
    entries: [],
    malformed: trailing === '' ? [] : [trailing],
  };
  for (let index = 0; index < records.length; index += 1) {
    const record = String(records[index]);
    index += readRecord(record, records[index + 1], state);
  }
  return {
    ...(state.commit_sha === undefined ? {} : { commit_sha: state.commit_sha }),
    ...(state.branch === undefined ? {} : { branch: state.branch }),
    detached_head: state.detached_head,
    entries: state.entries,
    malformed: state.malformed,
  };
}

// Reads one record; returns how many following records it consumed (the original path of a `2`).
function readRecord(record: string, next: string | undefined, state: ParseState): number {
  if (record.startsWith('# ')) {
    readHeader(record.slice(2), state);
    return 0;
  }
  const marker = record.slice(0, 2);
  if (marker === '? ' || marker === '! ') {
    readUntrackedOrIgnored(record, state);
    return 0;
  }
  const kind = record.slice(0, 1);
  if (record.charAt(1) === ' ' && isTrackedMarker(kind)) {
    readTracked(kind, record, state);
    return kind === '2' && next !== undefined ? 1 : 0;
  }
  state.malformed.push(record);
  return 0;
}

function readHeader(header: string, state: ParseState): void {
  const space = header.indexOf(' ');
  const name = space === -1 ? header : header.slice(0, space);
  const value = space === -1 ? '' : header.slice(space + 1);
  if (name === 'branch.oid') {
    state.commit_sha = value === '(initial)' || value === '' ? undefined : value;
  }
  if (name === 'branch.head') {
    state.detached_head = value === '(detached)';
    state.branch = state.detached_head || value === '' ? undefined : value;
  }
}

function readUntrackedOrIgnored(record: string, state: ParseState): void {
  const path = record.slice(2);
  if (path === '') {
    state.malformed.push(record);
    return;
  }
  state.entries.push({ kind: record.startsWith('?') ? 'untracked' : 'ignored', path });
}

function readTracked(marker: TrackedMarker, record: string, state: ParseState): void {
  const fields = splitLeading(record, LEADING_FIELDS[marker]);
  const path = fields?.rest;
  if (fields === undefined || path === undefined || path === '') {
    state.malformed.push(record);
    return;
  }
  state.entries.push({ kind: ENTRY_KINDS[marker], path, submodule: String(fields.leading[2]) });
}

// Splits off `count` space-separated fields; the rest (the path) may itself contain spaces.
function splitLeading(
  record: string,
  count: number,
): { readonly leading: readonly string[]; readonly rest: string } | undefined {
  const leading: string[] = [];
  let rest = record;
  for (let field = 0; field < count; field += 1) {
    const space = rest.indexOf(' ');
    if (space <= 0) {
      return undefined;
    }
    leading.push(rest.slice(0, space));
    rest = rest.slice(space + 1);
  }
  return { leading, rest };
}

function isTrackedMarker(value: string): value is TrackedMarker {
  return value === '1' || value === '2' || value === 'u';
}
