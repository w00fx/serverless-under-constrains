// Local binding of the operator input reader: the exact bytes of one file the operator names
// (`--env`, `--payment`, `--approved-decision`). A failure carries Node's error code and message,
// which name the path.

import { readFile } from 'node:fs/promises';

import { err, ok } from '../../record-contract/primitives.ts';
import type { Result } from '../../record-contract/primitives.ts';
import type { InputFileReader } from '../admit-commands.ts';

/**
 * Reads operator input files from local disk.
 *
 * @example
 * await new NodeInputFileReader().readBytes('/operator/payment.json'); // { ok: true, value: <bytes> }
 */
export class NodeInputFileReader implements InputFileReader {
  async readBytes(path: string): Promise<Result<Uint8Array, { readonly code: string; readonly detail: string }>> {
    try {
      return ok(new Uint8Array(await readFile(path)));
    } catch (error: unknown) {
      return err({ code: errorCode(error), detail: error instanceof Error ? error.message : String(error) });
    }
  }
}

function errorCode(error: unknown): string {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return typeof code === 'string' ? code : 'IO_ERROR';
}
