// fast-check parameters from the environment (design §12.5, §15.1): `npm run test:fuzz` sets
// FC_RUNS (10,000 by default) and a campaign sets FC_SEED per run so every failure replays.

export interface FuzzParameters {
  readonly numRuns: number;
  readonly seed?: number;
}

const DEFAULT_RUNS = 1000;

export function fuzzParameters(env: Readonly<Record<string, string | undefined>> = process.env): FuzzParameters {
  const runs = parseInteger('FC_RUNS', env['FC_RUNS']) ?? DEFAULT_RUNS;
  const seed = parseInteger('FC_SEED', env['FC_SEED']);
  return seed === undefined ? { numRuns: runs } : { numRuns: runs, seed };
}

function parseInteger(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name}=${JSON.stringify(raw)}; expected a safe integer`);
  }
  return value;
}
