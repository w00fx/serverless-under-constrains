// A minimal ustar reader for the evidence archive tests: the oracle that reads back what
// tools/lib/evidence-archive.ts writes. It decodes each header field as text, checks the header
// checksum independently, and stops at the first zero block.

/** One archive member: its header fields as written, and its content. */
export interface UstarMember {
  readonly path: string;
  readonly name: string;
  readonly prefix: string;
  readonly mode: string;
  readonly uid: string;
  readonly gid: string;
  readonly size: string;
  readonly mtime: string;
  readonly checksum: string;
  readonly typeflag: string;
  readonly magic: string;
  readonly version: string;
  readonly uname: string;
  readonly gname: string;
  readonly devmajor: string;
  readonly devminor: string;
  readonly checksumValid: boolean;
  readonly content: Uint8Array;
}

const BLOCK = 512;
const decoder = new TextDecoder();

/** Every member of `archive`, in archive order. */
export function readUstar(archive: Uint8Array): readonly UstarMember[] {
  const members: UstarMember[] = [];
  let offset = 0;
  while (offset + BLOCK <= archive.length && archive.subarray(offset, offset + BLOCK).some((byte) => byte !== 0)) {
    const header = archive.subarray(offset, offset + BLOCK);
    const size = Number.parseInt(field(header, 124, 12), 8);
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    members.push({
      path: prefix === '' ? name : `${prefix}/${name}`,
      name,
      prefix,
      mode: raw(header, 100, 8),
      uid: raw(header, 108, 8),
      gid: raw(header, 116, 8),
      size: raw(header, 124, 12),
      mtime: raw(header, 136, 12),
      checksum: raw(header, 148, 8),
      typeflag: raw(header, 156, 1),
      magic: raw(header, 257, 6),
      version: raw(header, 263, 2),
      uname: raw(header, 265, 32),
      gname: raw(header, 297, 32),
      devmajor: raw(header, 329, 8),
      devminor: raw(header, 337, 8),
      checksumValid: Number.parseInt(field(header, 148, 8), 8) === checksumOf(header),
      content: archive.slice(offset + BLOCK, offset + BLOCK + size),
    });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return members;
}

/** The byte offset where the end-of-archive zero blocks start. */
export function endOffset(archive: Uint8Array): number {
  return readUstar(archive).reduce(
    (offset, member) => offset + BLOCK + Math.ceil(member.content.length / BLOCK) * BLOCK,
    0,
  );
}

// The header bytes summed with the checksum field read as eight spaces.
function checksumOf(header: Uint8Array): number {
  return header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 0x20 : byte), 0);
}

// A text field up to its first NUL.
function field(header: Uint8Array, offset: number, length: number): string {
  return raw(header, offset, length).split('\0')[0] ?? '';
}

// A field's bytes as text, NULs included.
function raw(header: Uint8Array, offset: number, length: number): string {
  return decoder.decode(header.subarray(offset, offset + length));
}
