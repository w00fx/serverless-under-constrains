// The financial inputs and the Region of one counted execution (close-out, the owner's item 3).
// They are read from the frozen execution manifest and from every trial's payment and approved
// decision, which must all agree; the study derivation then cross-checks them with the spec's
// OR-RUA-001 financial fixture. A disagreement stops the derivation instead of choosing a source.

import type { JsonObject } from '../../src/record-contract/primitives.ts';
import type { ArtifactRef, CitedRecord, EvidencePackage } from './study-results-reading.ts';
import { byArtifactPath, integerOf, objectOf, readRecord, stringOf } from './study-results-reading.ts';

/** The financial fixture of a study: amounts in minor units of `currency`. */
export interface FinancialFixture {
  readonly approved_amount_minor: string;
  readonly captured_amount_minor: string;
  readonly currency: string;
}

/** One execution's financial inputs and Region, with the artifacts that state them. */
export interface ExecutionInputs extends FinancialFixture {
  readonly region: string;
  readonly evidence_refs: readonly ArtifactRef[];
}

// With its trailing space, so that a heading such as "### OR-RUA-0010" does not open the table.
const FIXTURE_HEADING = '### OR-RUA-001 ';
const FIXTURE_FIELDS = ['approved_amount_minor', 'captured_amount_minor', 'currency'] as const;
// A fixture table row: | `field` | `value` |
const FIXTURE_ROW = /^\| `([a-z_]+)` \| `([^`|]*)` \|$/;

/**
 * The inputs every trial of `pkg` was admitted with, refused unless the manifest, each trial's
 * payment and approved decision, and the manifest's two Region members agree.
 *
 * @example
 * deriveExecutionInputs(pkg, readRecord(pkg, 'admission/execution-manifest.json'), trialIds).currency; // 'BRL'
 */
export function deriveExecutionInputs(
  pkg: EvidencePackage,
  manifest: CitedRecord,
  trialIds: readonly string[],
): ExecutionInputs {
  const subject = `${pkg.directory}/${manifest.ref.artifact_path}`;
  const financial = objectOf(manifest.record, 'financial_inputs', subject);
  const fixture: FinancialFixture = {
    approved_amount_minor: String(integerOf(financial, 'approved_amount_minor', `${subject} financial_inputs`)),
    captured_amount_minor: String(integerOf(financial, 'captured_amount_minor', `${subject} financial_inputs`)),
    currency: stringOf(financial, 'currency', `${subject} financial_inputs`),
  };
  const region = stringOf(objectOf(manifest.record, 'environment', subject), 'region', `${subject} environment`);
  const safetyRegion = stringOf(objectOf(manifest.record, 'safety', subject), 'region', `${subject} safety`);
  if (safetyRegion !== region) {
    throw new Error(`${subject}: safety.region is ${safetyRegion}; expected environment.region ${region}`);
  }
  const trialRefs = trialIds.flatMap((trialId) => agreedTrialInputs(pkg, trialId, fixture));
  return { ...fixture, region, evidence_refs: [manifest.ref, ...trialRefs].sort(byArtifactPath) };
}

/**
 * The financial fixture of the spec's OR-RUA-001 table, refused unless each of its three fields
 * has exactly one row there.
 *
 * @example
 * financialFixtureOf(specText); // { approved_amount_minor: '10000', captured_amount_minor: '10000', currency: 'BRL' }
 */
export function financialFixtureOf(specMarkdown: string): FinancialFixture {
  const rows = new Map<string, string[]>();
  // A heading opens a new section; only rows under the OR-RUA-001 heading count.
  let inFixture = false;
  for (const line of specMarkdown.split('\n')) {
    if (line.startsWith('#')) {
      inFixture = line.startsWith(FIXTURE_HEADING);
      continue;
    }
    const row = inFixture ? FIXTURE_ROW.exec(line) : null;
    if (row === null) {
      continue;
    }
    // FIXTURE_ROW has two mandatory groups, so a match holds both.
    const [field, value] = [String(row[1]), String(row[2])];
    rows.set(field, [...(rows.get(field) ?? []), value]);
  }
  return {
    approved_amount_minor: fixtureValue(rows, 'approved_amount_minor'),
    captured_amount_minor: fixtureValue(rows, 'captured_amount_minor'),
    currency: fixtureValue(rows, 'currency'),
  };
}

/**
 * Refuses `inputs` unless they state the fixture's amounts and currency.
 *
 * @example
 * assertFixtureInputs(run.inputs, financialFixtureOf(specText), run.package_directory);
 */
export function assertFixtureInputs(inputs: FinancialFixture, fixture: FinancialFixture, subject: string): void {
  const differing = FIXTURE_FIELDS.filter((field) => inputs[field] !== fixture[field]);
  if (differing.length > 0) {
    const stated = differing.map((field) => `${field} ${inputs[field]}`).join(', ');
    const expected = differing.map((field) => `${field} ${fixture[field]}`).join(', ');
    throw new Error(`${subject} states ${stated}; expected OR-RUA-001's ${expected}`);
  }
}

function fixtureValue(rows: ReadonlyMap<string, readonly string[]>, field: string): string {
  const values = rows.get(field) ?? [];
  const [only] = values;
  if (only === undefined || values.length > 1) {
    throw new Error(
      `the spec holds ${String(values.length)} OR-RUA-001 rows for ${field}; expected one "| \`${field}\` | \`<value>\` |" row`,
    );
  }
  return only;
}

function agreedTrialInputs(pkg: EvidencePackage, trialId: string, fixture: FinancialFixture): readonly ArtifactRef[] {
  const payment = readRecord(pkg, `trials/${trialId}/inputs/payment.json`);
  const decision = readRecord(pkg, `trials/${trialId}/inputs/approved-decision.json`);
  assertStates(pkg, payment, 'captured_amount_minor', fixture);
  assertStates(pkg, decision, 'approved_amount_minor', fixture);
  return [payment.ref, decision.ref];
}

function assertStates(
  pkg: EvidencePackage,
  input: CitedRecord,
  amount: 'approved_amount_minor' | 'captured_amount_minor',
  fixture: FinancialFixture,
): void {
  const subject = `${pkg.directory}/${input.ref.artifact_path}`;
  const record: JsonObject = input.record;
  const stated = `${String(integerOf(record, amount, subject))} ${stringOf(record, 'currency', subject)}`;
  const expected = `${fixture[amount]} ${fixture.currency}`;
  if (stated !== expected) {
    throw new Error(`${subject}: ${amount} and currency are ${stated}; expected the manifest's ${expected}`);
  }
}
