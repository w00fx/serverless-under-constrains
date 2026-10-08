// Fuzz campaign reports (design §12.5, testing rule 7). A generative campaign runs every
// property with a fresh recorded seed; each report names the tool and version, the target,
// the budget, the seeds and the executed cases, and keeps every counterexample with the seed
// and path that replay it. Zero executed properties is not verification.

export interface CampaignFailure {
  readonly test: string;
  readonly message: string;
}

export interface CampaignRun {
  readonly seed: number;
  /** Properties (tests) that passed in this campaign. */
  readonly passed: number;
  readonly failures: readonly CampaignFailure[];
}

export interface FastCheckFailure {
  readonly tests_run?: number;
  readonly seed?: number;
  readonly path?: string;
  readonly counterexample?: string;
}

export interface Counterexample extends FastCheckFailure {
  readonly test: string;
  readonly campaign_seed: number;
}

export interface FuzzReport {
  readonly tool: string;
  readonly target: string;
  readonly mode: 'generative';
  readonly runs: number;
  readonly seeds: readonly number[];
  readonly properties: number;
  readonly executed: number;
  readonly failures: number;
  readonly counterexamples: readonly Counterexample[];
}

/**
 * Extracts replay data from a fast-check failure message.
 *
 * @example
 * parseFastCheckFailure('Property failed after 7 tests\n{ seed: 42, path: "6:1", endOnFailure: true }\nCounterexample: [50]');
 * // { tests_run: 7, seed: 42, path: '6:1', counterexample: '[50]' }
 */
export function parseFastCheckFailure(message: string): FastCheckFailure {
  const testsRun = /Property failed after (\d+) tests/.exec(message)?.[1];
  const seed = /seed: (-?\d+)/.exec(message)?.[1];
  const path = /path: "([^"]*)"/.exec(message)?.[1];
  const counterexample = /^Counterexample: (.*)$/m.exec(message)?.[1];
  return {
    ...(testsRun === undefined ? {} : { tests_run: Number(testsRun) }),
    ...(seed === undefined ? {} : { seed: Number(seed) }),
    ...(path === undefined ? {} : { path }),
    ...(counterexample === undefined ? {} : { counterexample }),
  };
}

/**
 * Builds the report of one target across its campaigns. A passing property executed
 * `runs` cases; a failing one executed the count fast-check reports before failing.
 *
 * @example
 * buildFuzzReport({ tool: 'fast-check@4.10.2', target: 'record-contract/jsonl', runs: 20000, campaigns });
 */
export function buildFuzzReport(input: {
  readonly tool: string;
  readonly target: string;
  readonly runs: number;
  readonly campaigns: readonly CampaignRun[];
}): FuzzReport {
  const counterexamples = input.campaigns.flatMap((campaign) =>
    campaign.failures.map((failure) => ({
      test: failure.test,
      campaign_seed: campaign.seed,
      ...parseFastCheckFailure(failure.message),
    })),
  );
  const passedCases = input.campaigns.reduce((total, campaign) => total + campaign.passed * input.runs, 0);
  const failedCases = counterexamples.reduce((total, example) => total + (example.tests_run ?? 0), 0);
  return {
    tool: input.tool,
    target: input.target,
    mode: 'generative',
    runs: input.runs,
    seeds: input.campaigns.map((campaign) => campaign.seed),
    properties: input.campaigns.reduce((total, campaign) => total + campaign.passed + campaign.failures.length, 0),
    executed: passedCases + failedCases,
    failures: counterexamples.length,
    counterexamples,
  };
}

/**
 * Names a fuzz target after its file: `test/fuzz/<feature>/<name>.fuzz.test.ts` gives `<feature>/<name>`.
 *
 * @example
 * fuzzTargetName('test/fuzz/record-contract/jsonl.fuzz.test.ts'); // 'record-contract/jsonl'
 */
export function fuzzTargetName(file: string): string {
  const match = /(?:^|\/)test\/fuzz\/(.+)\.fuzz\.test\.ts$/.exec(file);
  if (match?.[1] === undefined) {
    throw new Error(`fuzz file ${JSON.stringify(file)}; expected test/fuzz/<feature>/<name>.fuzz.test.ts`);
  }
  return match[1];
}
