// BR-RUA-007 equality (design §8.14, AC-RUA-009): every projection compares the same fields across
// the trials it covers. A difference is declared only when it lies in a projection whose §8.14 row
// lists declared variant differences, is one of the manifest's declared variant differences, and
// every trial shows exactly its variant's declared value; any other
// difference is `UNDECLARED_DIFFERENCE: <projection>.<field>`, fails the projection and later makes
// the comparison ineligible. It never touches an individual verdict: this module reads no oracle
// result.

import { boundedJsonText } from '../record-contract/json-value.ts';
import { canonicalJson, structurallyEqual } from '../record-contract/canonical-json.ts';
import type { JsonValue, Scenario, StructuredReason, VariantId } from '../record-contract/primitives.ts';
import { RUN_TRIAL_ORDER } from '../record-contract/records/group-a/execution_manifest.ts';
import type { DeclaredVariantDifference } from '../record-contract/records/group-a/execution_manifest.ts';
import type {
  EqualityProjection,
  ProjectedFieldValue,
  ProjectionDifference,
} from '../record-contract/records/group-c/comparison_assessment.ts';
import type { EqualityProjectionId, PreservationVerdict } from '../record-contract/records/group-c/vocabulary.ts';
import { comparisonReason, uniqueSortedRefs } from './comparison-reasons.ts';
import type { ComparisonTrialInputs, ProjectionSheet } from './equality-sheets.ts';

/** The eight projections in their fixed order (design §8.14 table). */
export type EightEqualityProjections = readonly [
  EqualityProjection,
  EqualityProjection,
  EqualityProjection,
  EqualityProjection,
  EqualityProjection,
  EqualityProjection,
  EqualityProjection,
  EqualityProjection,
];

/**
 * The BR-RUA-007 result of one run (design §5.3 `EqualityAssessment`): `fail` on any undeclared
 * difference, else `indeterminate` on any missing input, else `pass`. A result other than `pass`
 * always carries its reasons: one `UNDECLARED_DIFFERENCE` per undeclared field, and the reason of
 * every missing input.
 */
export type EqualityAssessment = { readonly projections: EightEqualityProjections } & (
  | { readonly equality_result: 'pass'; readonly reasons: readonly [] }
  | {
      readonly equality_result: 'fail' | 'indeterminate';
      readonly reasons: readonly [StructuredReason, ...StructuredReason[]];
    }
);

/** The scenario a projection is restricted to; the others cover all four trials. */
const PROJECTION_SCENARIO: Readonly<Partial<Record<EqualityProjectionId, Scenario>>> = {
  control_parameters: 'CONTROL',
  treatment_parameters: 'COMMIT_THEN_TIMEOUT',
};

/**
 * The projections whose design §8.14 row lists declared variant differences (source visibility
 * timeout; Durable execution strategy). BR-RUA-007 excuses only "differences explicitly declared as
 * part of the variants' execution strategies", so a manifest declaration never excuses a difference
 * in financial inputs, scenario parameters, provider, controller or observation settings.
 */
const DECLARABLE_PROJECTIONS: ReadonlySet<EqualityProjectionId> = new Set(['message_source_protocol', 'caller_timing']);

/** What a difference lists for a trial that lacks the field, or holds JSON null (values are never null). */
const ABSENT_VALUE = '<absent>';
const NULL_VALUE = '<null>';

interface CoveredSheet {
  readonly trial: ComparisonTrialInputs;
  readonly sheet: ProjectionSheet;
}

interface ProjectionOutcome {
  readonly projection: EqualityProjection;
  readonly reasons: readonly StructuredReason[];
}

/**
 * Evaluates the eight equality projections over the declared trials.
 *
 * @example
 * const equality = evaluateEquality(trials.map(buildTrialSheets), manifest.declared_variant_differences);
 * equality.equality_result; // 'pass' when only declared differences remain
 */
export function evaluateEquality(
  trials: readonly ComparisonTrialInputs[],
  declared: readonly DeclaredVariantDifference[],
): EqualityAssessment {
  const evaluate = (id: EqualityProjectionId): ProjectionOutcome => evaluateProjection(id, trials, declared);
  const outcomes = [
    evaluate('financial_inputs'),
    evaluate('control_parameters'),
    evaluate('treatment_parameters'),
    evaluate('message_source_protocol'),
    evaluate('provider_configuration'),
    evaluate('controller_configuration'),
    evaluate('caller_timing'),
    evaluate('observation_window'),
  ] as const;
  const projections: EightEqualityProjections = [
    outcomes[0].projection,
    outcomes[1].projection,
    outcomes[2].projection,
    outcomes[3].projection,
    outcomes[4].projection,
    outcomes[5].projection,
    outcomes[6].projection,
    outcomes[7].projection,
  ];
  const [first, ...rest] = outcomes.flatMap((outcome) => outcome.reasons);
  // A projection is `pass` exactly when it has no reason, so reasons exist iff some projection is not `pass`.
  return first === undefined
    ? { projections, equality_result: 'pass', reasons: [] }
    : { projections, equality_result: failedResult(projections), reasons: [first, ...rest] };
}

function evaluateProjection(
  id: EqualityProjectionId,
  trials: readonly ComparisonTrialInputs[],
  declared: readonly DeclaredVariantDifference[],
): ProjectionOutcome {
  const scenario = PROJECTION_SCENARIO[id];
  const covered = trials.filter((trial) => scenario === undefined || trial.scenario === scenario);
  const expected = RUN_TRIAL_ORDER.filter((slot) => scenario === undefined || slot.scenario === scenario).length;
  const sheets: CoveredSheet[] = [];
  const gaps: StructuredReason[] = covered.length === expected ? [] : [coverageGap(id, covered.length, expected)];
  for (const trial of covered) {
    const input = trial.projections[id];
    if ('sheet' in input) {
      sheets.push({ trial, sheet: input.sheet });
    } else {
      gaps.push(...input.missing);
    }
  }
  const differences = [
    ...fieldDifferences(id, sheets, 'common', declared),
    ...variantGroups(sheets).flatMap((group) => fieldDifferences(id, group, 'within_variant', declared)),
  ];
  const undeclared = differences
    .filter((difference) => !difference.declared)
    .map((difference) => undeclaredReason(id, difference));
  const result: PreservationVerdict = undeclared.length > 0 ? 'fail' : gaps.length > 0 ? 'indeterminate' : 'pass';
  const compared = [
    ...new Set(sheets.flatMap(({ sheet }) => [...Object.keys(sheet.common), ...Object.keys(sheet.within_variant)])),
  ];
  return {
    projection: {
      projection_id: id,
      result,
      // A projection with no sheet at all still names what it compares: the projection as a whole.
      compared_fields: compared.length > 0 ? compared : [id],
      differences,
      evidence_refs: uniqueSortedRefs(sheets.flatMap(({ sheet }) => sheet.evidence_refs)),
    },
    reasons: [...undeclared, ...gaps],
  };
}

// Every field named by any sheet, compared across the given sheets; one difference per field whose
// values are not all structurally equal.
function fieldDifferences(
  id: EqualityProjectionId,
  sheets: readonly CoveredSheet[],
  part: 'common' | 'within_variant',
  declared: readonly DeclaredVariantDifference[],
): readonly ProjectionDifference[] {
  const fields = [...new Set(sheets.flatMap(({ sheet }) => Object.keys(sheet[part])))];
  return fields.flatMap((field) => {
    const values = sheets.map(({ trial, sheet }) => ({ trial, value: ownValue(sheet[part], field) }));
    const keys = new Set(values.map(({ value }) => (value === undefined ? ABSENT_VALUE : canonicalJson(value))));
    if (keys.size <= 1) {
      return [];
    }
    return [
      {
        field,
        declared: isDeclaredDifference(id, field, values, declared),
        values: values.map(({ trial, value }): ProjectedFieldValue => ({
          trial_id: trial.trial_id,
          value: reported(value),
        })),
      },
    ];
  });
}

// Same-variant groups of the covered sheets, conventional first.
function variantGroups(sheets: readonly CoveredSheet[]): readonly (readonly CoveredSheet[])[] {
  const variants: readonly VariantId[] = ['conventional', 'durable'];
  return variants.map((variant) => sheets.filter(({ trial }) => trial.variant_id === variant));
}

// Declared only in a declarable projection, when the manifest declares this field and each trial shows
// its variant's declared value.
function isDeclaredDifference(
  id: EqualityProjectionId,
  field: string,
  values: readonly { readonly trial: ComparisonTrialInputs; readonly value: JsonValue | undefined }[],
  declared: readonly DeclaredVariantDifference[],
): boolean {
  const declaration = declared.find((difference) => difference.parameter === field);
  return (
    DECLARABLE_PROJECTIONS.has(id) &&
    declaration !== undefined &&
    values.every(({ trial, value }) => value !== undefined && structurallyEqual(value, declaration[trial.variant_id]))
  );
}

function failedResult(projections: EightEqualityProjections): 'fail' | 'indeterminate' {
  return projections.some((projection) => projection.result === 'fail') ? 'fail' : 'indeterminate';
}

// Own members only: a field named `constructor` or `toString` is never an inherited value (A-05).
function ownValue(fields: Readonly<Record<string, JsonValue>>, field: string): JsonValue | undefined {
  return Object.hasOwn(fields, field) ? fields[field] : undefined;
}

function reported(value: JsonValue | undefined): JsonValue {
  if (value === undefined) {
    return ABSENT_VALUE;
  }
  return value ?? NULL_VALUE;
}

function undeclaredReason(id: EqualityProjectionId, difference: ProjectionDifference): StructuredReason {
  const values = difference.values.map(({ trial_id, value }) => `${trial_id}=${boundedJsonText(value)}`).join(', ');
  return comparisonReason(
    'UNDECLARED_DIFFERENCE',
    `${id}.${difference.field}`,
    `UNDECLARED_DIFFERENCE: ${id}.${difference.field} has values ${values}; expected one value across the compared trials or a declared variant difference`,
  );
}

function coverageGap(id: EqualityProjectionId, covered: number, expected: number): StructuredReason {
  return comparisonReason(
    'EQUALITY_INDETERMINATE',
    id,
    `${String(covered)} trial input(s) cover ${id}; expected the ${String(expected)} declared trial(s) it compares`,
  );
}
