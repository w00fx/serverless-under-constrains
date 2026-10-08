// The public redacted copy as it is published (close-out): its README, manifest and verdict
// recheck as plain files, and every package file and verification record in one deterministic
// ustar archive, so the repository holds four files instead of one per evidence file. A reader
// extracts the archive in place (`tar -xzf study-1-evidence.tar.gz`), which restores every path
// the README and the manifest name.

/** The archive's file name in the copy directory. */
export const ARCHIVE_NAME = 'study-1-evidence.tar.gz';

/** The copy files kept outside the archive, readable without extracting it. */
export const PLAIN_FILES: readonly string[] = ['README.md', 'redaction-manifest.json', 'verdict-recheck.json'];

/** The copy as published: the plain files by name, and the uncompressed archive of every other file. */
export interface PublishedCopy {
  readonly plain: ReadonlyMap<string, Uint8Array>;
  readonly tar: Uint8Array;
}

const BLOCK = 512;
// GNU tar and bsdtar write records of 20 blocks; readers accept any length, but a full record
// keeps both quiet.
const RECORD = 20 * BLOCK;
const NAME_BYTES = 100;
const PREFIX_BYTES = 155;
// The size field holds 11 octal digits.
const MAX_SIZE = 8 ** 11 - 1;
const SLASH = 0x2f;
const encoder = new TextEncoder();

/**
 * The copy files split into the plain files and one archive of the rest.
 *
 * @example
 * publishedCopy(deriveRedactedCopy(input).files).plain.has('README.md'); // true
 */
export function publishedCopy(files: ReadonlyMap<string, Uint8Array>): PublishedCopy {
  const entries = [...files];
  return {
    plain: new Map(entries.filter(([path]) => PLAIN_FILES.includes(path))),
    tar: ustarArchive(new Map(entries.filter(([path]) => !PLAIN_FILES.includes(path)))),
  };
}

/**
 * A ustar archive of `files`, the same bytes for the same files in the same order: entries in the
 * order given (the copy's derivation order, which the manifest lists), regular files only
 * (extraction creates the folders), mode 0644, owner 0:0 without names, and time 0.
 *
 * @example
 * ustarArchive(new Map([['runs/x/package-index.json', bytes]])).length % 10240; // 0
 */
export function ustarArchive(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const parts = [...files].flatMap(([path, bytes]) => [
    ustarHeader(path, bytes.length),
    bytes,
    new Uint8Array((BLOCK - (bytes.length % BLOCK)) % BLOCK),
  ]);
  // Two zero blocks end the archive.
  const length = parts.reduce((total, part) => total + part.length, 2 * BLOCK);
  const archive = new Uint8Array(Math.ceil(length / RECORD) * RECORD);
  let offset = 0;
  for (const part of parts) {
    archive.set(part, offset);
    offset += part.length;
  }
  return archive;
}

/**
 * The 512-byte ustar header of one regular file of `size` bytes at `path`, refused when the path
 * or the size does not fit its fields.
 *
 * @example
 * ustarHeader('runs/x/package-index.json', 1234).length; // 512
 */
export function ustarHeader(path: string, size: number): Uint8Array {
  if (size > MAX_SIZE) {
    throw new Error(`${path} is ${String(size)} bytes; expected at most ${String(MAX_SIZE)}, the ustar size limit`);
  }
  const { prefix, name } = headerNames(path);
  const block = new Uint8Array(BLOCK);
  block.set(name, 0);
  block.set(encoder.encode('0000644\0'), 100);
  block.set(encoder.encode('0000000\0'), 108);
  block.set(encoder.encode('0000000\0'), 116);
  block.set(encoder.encode(`${size.toString(8).padStart(11, '0')}\0`), 124);
  block.set(encoder.encode('00000000000\0'), 136);
  // The checksum is summed with its own field read as eight spaces.
  block.set(encoder.encode('        '), 148);
  block.set(encoder.encode('0'), 156);
  block.set(encoder.encode('ustar\0'), 257);
  block.set(encoder.encode('00'), 263);
  block.set(prefix, 345);
  const checksum = block.reduce((total, byte) => total + byte, 0);
  block.set(encoder.encode(`${checksum.toString(8).padStart(6, '0')}\0 `), 148);
  return block;
}

// A path longer than the name field goes in two fields that a reader joins with a slash: the
// prefix before the first slash that leaves at most 100 bytes of name.
function headerNames(path: string): { readonly prefix: Uint8Array; readonly name: Uint8Array } {
  const bytes = encoder.encode(path);
  if (bytes.length <= NAME_BYTES) {
    return { prefix: new Uint8Array(0), name: bytes };
  }
  let slash = bytes.indexOf(SLASH);
  while (slash !== -1 && bytes.length - slash - 1 > NAME_BYTES) {
    slash = bytes.indexOf(SLASH, slash + 1);
  }
  if (slash === -1 || slash > PREFIX_BYTES) {
    throw new Error(
      `${path} is ${String(bytes.length)} bytes; expected at most ${String(NAME_BYTES)}, or a slash ` +
        `after at most ${String(PREFIX_BYTES)} bytes that leaves at most ${String(NAME_BYTES)}`,
    );
  }
  return { prefix: bytes.subarray(0, slash), name: bytes.subarray(slash + 1) };
}
