// Arbitrary edits of a base trial's evidence for the oracle properties (design §12.5): a member of
// any record of the subject's journals, ledger snapshot, settlement samples, inputs or the shared
// runner journal set to a value drawn from the trial's own identities, instants and vocabulary (so
// edits reach the oracle's joins and gates, not only schema rejection) or from arbitrary JSON; a
// record dropped or duplicated; a file deleted. The edited files are ingested with the real
// validator, as production ingests them.

import fc from 'fast-check';

import { ingestEvidence } from '../../../../src/evidence-ingestion/ingest-evidence.ts';
import type { IngestedEvidence } from '../../../../src/evidence-ingestion/ingestion-model.ts';
import { isJsonObject } from '../../../../src/record-contract/json-value.ts';
import { parseJsonDocument } from '../../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { ingestionInputFromFiles } from '../../../golden/evidence-ingestion/ingestion-input.ts';
import type { BaseScenarioId } from '../../../support/golden-builder/golden-plan.ts';
import { subjectDirectoryOf } from '../../../support/golden-builder/scenario-builder.ts';
import { builtFiles, ORACLE_VALIDATOR } from '../../../unit/trial-oracle/support/built-trials.ts';

/** Every trial base: the oracle must hold on each. */
export const TRIAL_BASES = [
  'run-conventional-control',
  'run-durable-control',
  'run-conventional-treatment',
  'run-durable-treatment',
  'validation-conventional-control',
  'validation-conventional-treatment',
  'validation-durable-control',
  'validation-durable-treatment',
] as const satisfies readonly BaseScenarioId[];

/** The files the edits touch; `$trial/` is the subject trial's directory. */
const EDITED_FILES = [
  '$trial/journals/caller-journal.jsonl',
  '$trial/journals/provider-journal.jsonl',
  '$trial/ledger/ledger-snapshot.json',
  '$trial/settlement/settlement-samples.jsonl',
  '$trial/inputs/payment.json',
  '$trial/inputs/approved-decision.json',
  'runner/runner-journal.jsonl',
] as const;

/** Members the oracle's gates and rules read. */
const MEMBERS = [
  'record_type',
  'event_id',
  'attempt_id',
  'attempt_ids',
  'refund_request_id',
  'payment_id',
  'amount_minor',
  'approved_amount_minor',
  'captured_amount_minor',
  'currency',
  'provider_transaction_id',
  'provider_call_id',
  'processing_state',
  'processing_terminal_reason',
  'effect_knowledge',
  'version',
  'outcome',
  'approximate_receive_count',
  'source_instance_id',
  'source_sequence',
  'occurred_at',
  'captured_at',
  'consistent_read',
  'complete',
  'writer',
  'status',
  'transactions',
  'pages',
  'message_id',
  'established_at',
  'rechecked_at',
  'window_start',
  'causation_event_ids',
] as const;

const WORDS: readonly JsonValue[] = [
  'FINISHED',
  'RUNNING',
  'SUCCEEDED',
  'RETRIES_EXHAUSTED',
  'TIMED_OUT',
  'FAILED',
  'UNKNOWN',
  'ONE_EFFECT_CONFIRMED',
  'established',
  'not_established',
  'evidence_collector',
  'runner',
  'USD',
  'BRL',
  'ref-poc-002',
  'pay-poc-999',
  '2026-10-05T12:00:00.000Z',
  '2026-10-05T13:59:59.999Z',
  true,
  false,
  null,
  0,
  1,
  2,
  3,
  10000,
  20000,
  [],
];

/** One edit of one evidence file. */
export type TrialFileEdit =
  | {
      readonly kind: 'set';
      readonly file: number;
      readonly line: number;
      readonly member: string;
      readonly value: JsonValue;
    }
  | { readonly kind: 'drop' | 'duplicate'; readonly file: number; readonly line: number }
  | { readonly kind: 'delete'; readonly file: number };

/** A base and up to four edits of its evidence. */
export interface EditedTrial {
  readonly base: (typeof TRIAL_BASES)[number];
  readonly edits: readonly TrialFileEdit[];
  /** Picks the trial's own values (identities, instants) for `set` edits. */
  readonly own_value: number;
}

const fileArbitrary = fc.nat({ max: EDITED_FILES.length - 1 });
const lineArbitrary = fc.nat({ max: 15 });

const editArbitrary: fc.Arbitrary<TrialFileEdit> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('set' as const),
      file: fileArbitrary,
      line: lineArbitrary,
      member: fc.constantFrom(...MEMBERS),
      value: fc.oneof(fc.constantFrom(...WORDS), fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue>),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constantFrom('drop' as const, 'duplicate' as const),
      file: fileArbitrary,
      line: lineArbitrary,
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), file: fileArbitrary }) },
);

/** A trial base with up to four edits; about one case in five keeps the base unedited. */
export const editedTrialArbitrary: fc.Arbitrary<EditedTrial> = fc.record({
  base: fc.constantFrom(...TRIAL_BASES),
  edits: fc.array(editArbitrary, { maxLength: 4 }),
  own_value: fc.nat(),
});

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const ownValues = new Map<string, readonly JsonValue[]>();

/**
 * The subject trial's ingested evidence after the edits; a line index wraps around a file's
 * records. A `set` edit draws its value from the trial's own values one time in two.
 *
 * @example
 * editedTrialEvidence({ base: 'run-conventional-control', edits: [], own_value: 0 });
 */
export function editedTrialEvidence(trial: EditedTrial): IngestedEvidence {
  const subject = subjectDirectoryOf(trial.base);
  const files = new Map(builtFiles({ base: trial.base }));
  const values = valuesOf(trial.base, files);
  for (const edit of trial.edits) {
    const path = resolved(EDITED_FILES[edit.file] ?? EDITED_FILES[0], subject);
    const bytes = files.get(path);
    if (bytes === undefined) {
      continue;
    }
    if (edit.kind === 'delete') {
      files.delete(path);
      continue;
    }
    const own = values[(trial.own_value + edit.line) % values.length];
    const chosen =
      edit.kind === 'set' && trial.own_value % 2 === 0 && own !== undefined ? { ...edit, value: own } : edit;
    files.set(path, encoder.encode(editedText(decoder.decode(bytes), path.endsWith('.jsonl'), chosen)));
  }
  return ingestEvidence(ingestionInputFromFiles(files, subject), ORACLE_VALIDATOR);
}

function resolved(path: string, subject: string): string {
  return path.startsWith('$trial/') ? `${subject}/${path.slice('$trial/'.length)}` : path;
}

function editedText(text: string, journal: boolean, edit: Exclude<TrialFileEdit, { readonly kind: 'delete' }>): string {
  const lines = journal ? text.split('\n').filter((line) => line.length > 0) : [text];
  if (lines.length === 0) {
    return text;
  }
  const at = edit.line % lines.length;
  const replaced = editedLines(lines[at] ?? '', edit);
  const result = [...lines.slice(0, at), ...replaced, ...lines.slice(at + 1)];
  return journal ? `${result.join('\n')}\n` : result.join('');
}

function editedLines(line: string, edit: Exclude<TrialFileEdit, { readonly kind: 'delete' }>): readonly string[] {
  if (edit.kind !== 'set') {
    return edit.kind === 'drop' ? [] : [line, line];
  }
  // An earlier edit may have left a document that is no longer one JSON object; it stays as is.
  const parsed = parseJsonDocument(encoder.encode(line));
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    return [line];
  }
  return [JSON.stringify({ ...parsed.value, [edit.member]: edit.value })];
}

// The string and number values the edited files hold, so an edit can swap one identity or instant
// for another the trial really has.
function valuesOf(base: string, files: ReadonlyMap<string, Uint8Array>): readonly JsonValue[] {
  const cached = ownValues.get(base);
  if (cached !== undefined) {
    return cached;
  }
  const subject = subjectDirectoryOf(base as (typeof TRIAL_BASES)[number]);
  const found = new Set<string | number>();
  for (const file of EDITED_FILES) {
    const text = decoder.decode(files.get(resolved(file, subject)) ?? new Uint8Array());
    for (const match of text.matchAll(/"[a-z_]+":("[^"\\]{1,80}"|-?\d{1,6})/g)) {
      const parsed = JSON.parse(match[1] ?? 'null') as string | number;
      found.add(parsed);
    }
  }
  const values = [...found].toSorted((a, b) => String(a).localeCompare(String(b)));
  ownValues.set(base, values);
  return values;
}
