// Arbitrary edits of the base probe's journals and treatment snapshot for the treatment-fidelity
// and probe-verdict properties (design §12.5): a member of any event set to a value drawn from the
// probe's own identities, instants and vocabulary (so edits reach the conditions' joins, not only
// schema rejection) or from arbitrary JSON, an event dropped or duplicated. The edited files are
// ingested with the real validator, as production ingests them. A second arbitrary edits the
// artifacts the probe counts and settles by (ledger snapshot, settlement samples, runner journal)
// with their own members and values, so neither arbitrary dilutes the other.

import fc from 'fast-check';

import { ingestEvidence } from '../../../../src/evidence-ingestion/ingest-evidence.ts';
import type { IngestedEvidence } from '../../../../src/evidence-ingestion/ingestion-model.ts';
import { isJsonObject } from '../../../../src/record-contract/json-value.ts';
import { parseJsonDocument } from '../../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import {
  GOLDEN_VALIDATOR,
  probeIngestionInput,
} from '../../../golden/transport-qualification/verdict/support/probe-golden.ts';
import { PROBE_IDS, probeFiles } from '../../../unit/treatment-fidelity/support/treatment-evidence.ts';

/** The probe files the journal edits touch. */
export const EDITED_FILES = [
  'probe/journals/caller-journal.jsonl',
  'probe/journals/provider-journal.jsonl',
  'probe/journals/controller-journal.jsonl',
  'probe/state/treatment-state-snapshot.json',
] as const;

/** The probe files the counted-artifact edits touch. */
export const COUNTED_FILES = [
  'probe/ledger/ledger-snapshot.json',
  'probe/settlement/settlement-samples.jsonl',
  'runner/runner-journal.jsonl',
] as const;
type EditedFile = (typeof EDITED_FILES)[number] | (typeof COUNTED_FILES)[number];

/** Members the six conditions and fidelity read. */
const MEMBERS = [
  'record_type',
  'event_id',
  'attempt_id',
  'causation_event_ids',
  'source_sequence',
  'source_instance_id',
  'occurred_at',
  'committed_at',
  'timer_fired_at',
  'abort_requested_at',
  'recorded_at',
  'elapsed_ns',
  'arbiter_winner',
  'transport_settled_at_claim',
  'monotonic_origin_event_id',
  'outcome',
  'targeted',
  'signal_event_id',
  'caller_timeout_event_id',
  'provider_commit_event_id',
  'provider_commit_id',
  'provider_transaction_id',
  'provider_call_id',
  'settlement_kind',
  'consistent_read',
  'item_present',
] as const;

/** Members the probe counts and its settlement re-derivation read. */
const COUNTED_MEMBERS = [
  'record_type',
  'event_id',
  'source_sequence',
  'occurred_at',
  'lambda_request_id',
  'provider_transaction_id',
  'transactions',
  'complete',
  'consistent_read',
  'status',
  'window_start',
  'established_at',
  'rechecked_at',
  'phase',
  'observed_at',
  'provider_active_calls',
  'processing_terminal',
] as const;

const IDS = Object.values(PROBE_IDS);
const INSTANTS = [
  '2026-10-05T12:05:05.130Z',
  '2026-10-05T12:05:08.040Z',
  '2026-10-05T12:05:08.041Z',
  '2026-10-05T12:05:08.050Z',
  '2026-10-05T12:05:09.000Z',
];
const WORDS = [
  'TIMER',
  'TRANSPORT',
  'TIMED_OUT',
  'SUCCEEDED',
  'REJECTED',
  'resolved',
  'aborted',
  '2999999999',
  '3000000000',
];

/** The base probe's settlement instants (window, establishment, recheck) and one long before. */
const SETTLEMENT_INSTANTS = [
  '2026-10-05T11:55:00.000Z',
  '2026-10-05T12:05:35.000Z',
  '2026-10-05T12:07:05.000Z',
  '2026-10-05T12:07:35.000Z',
  '2026-10-05T12:07:40.000Z',
];
const SETTLEMENT_WORDS = ['established', 'not_established', 'observation', 'pre_freeze_recheck'];

function valueArbitraryOf(constants: readonly JsonValue[]): fc.Arbitrary<JsonValue> {
  return fc.oneof(
    fc.constantFrom<JsonValue>(...constants, true, false, null, 0, 1, 5, 6),
    fc.subarray([...IDS], { maxLength: 3 }),
    fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue>,
  );
}

/** One edit of one probe file. */
export type JournalEdit =
  | {
      readonly kind: 'set';
      readonly file: EditedFile;
      readonly line: number;
      readonly member: string;
      readonly value: JsonValue;
    }
  | { readonly kind: 'drop' | 'duplicate'; readonly file: EditedFile; readonly line: number };

const lineArbitrary = fc.nat({ max: 7 });

function editsArbitrary(
  files: readonly EditedFile[],
  members: readonly string[],
  constants: readonly JsonValue[],
): fc.Arbitrary<readonly JournalEdit[]> {
  const fileArbitrary = fc.constantFrom(...files);
  return fc.array(
    fc.oneof(
      fc.record({
        kind: fc.constant('set' as const),
        file: fileArbitrary,
        line: lineArbitrary,
        member: fc.constantFrom(...members),
        value: valueArbitraryOf(constants),
      }),
      fc.record({
        kind: fc.constantFrom('drop' as const, 'duplicate' as const),
        file: fileArbitrary,
        line: lineArbitrary,
      }),
    ),
    { maxLength: 4 },
  );
}

/** Up to four edits of the probe's journals and snapshot. */
export const journalEditsArbitrary: fc.Arbitrary<readonly JournalEdit[]> = editsArbitrary(EDITED_FILES, MEMBERS, [
  ...IDS,
  ...INSTANTS,
  ...WORDS,
]);

/** Up to four edits of the ledger snapshot, settlement samples and runner journal. */
export const countedEditsArbitrary: fc.Arbitrary<readonly JournalEdit[]> = editsArbitrary(
  COUNTED_FILES,
  COUNTED_MEMBERS,
  [...IDS, ...SETTLEMENT_INSTANTS, ...SETTLEMENT_WORDS],
);

const BASE_FILES = probeFiles();
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The probe's ingested evidence after the edits; a line index wraps around the file's records.
 *
 * @example
 * editedProbeEvidence([{ kind: 'drop', file: 'probe/journals/caller-journal.jsonl', line: 3 }]);
 */
export function editedProbeEvidence(edits: readonly JournalEdit[]): IngestedEvidence {
  const files = new Map(BASE_FILES);
  for (const edit of edits) {
    files.set(edit.file, encoder.encode(edited(decoder.decode(files.get(edit.file)), edit)));
  }
  return ingestEvidence(probeIngestionInput(files), GOLDEN_VALIDATOR);
}

function edited(text: string, edit: JournalEdit): string {
  const document = !edit.file.endsWith('.jsonl');
  const lines = document ? [text] : text.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) {
    return text;
  }
  const at = edit.line % lines.length;
  const target = lines[at] ?? '';
  const replaced = editedLines(target, edit);
  const result = [...lines.slice(0, at), ...replaced, ...lines.slice(at + 1)];
  return document ? result.join('') : `${result.join('\n')}\n`;
}

function editedLines(line: string, edit: JournalEdit): readonly string[] {
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
