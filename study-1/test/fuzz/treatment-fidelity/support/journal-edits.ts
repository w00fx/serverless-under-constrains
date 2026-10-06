// Arbitrary edits of the base probe's journals and treatment snapshot for the treatment-fidelity
// and probe-verdict properties (design §12.5): a member of any event set to a value drawn from the
// probe's own identities, instants and vocabulary (so edits reach the conditions' joins, not only
// schema rejection) or from arbitrary JSON, an event dropped or duplicated. The edited files are
// ingested with the real validator, as production ingests them.

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

/** The probe files the edits touch. */
export const EDITED_FILES = [
  'probe/journals/caller-journal.jsonl',
  'probe/journals/provider-journal.jsonl',
  'probe/journals/controller-journal.jsonl',
  'probe/state/treatment-state-snapshot.json',
] as const;
type EditedFile = (typeof EDITED_FILES)[number];

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

const valueArbitrary: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constantFrom<JsonValue>(...IDS, ...INSTANTS, ...WORDS, true, false, null, 0, 1, 5, 6),
  fc.subarray([...IDS], { maxLength: 3 }),
  fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue>,
);

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

const fileArbitrary = fc.constantFrom(...EDITED_FILES);
const lineArbitrary = fc.nat({ max: 7 });

/** Up to four edits of the probe's journals and snapshot. */
export const journalEditsArbitrary: fc.Arbitrary<readonly JournalEdit[]> = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant('set' as const),
      file: fileArbitrary,
      line: lineArbitrary,
      member: fc.constantFrom(...MEMBERS),
      value: valueArbitrary,
    }),
    fc.record({
      kind: fc.constantFrom('drop' as const, 'duplicate' as const),
      file: fileArbitrary,
      line: lineArbitrary,
    }),
  ),
  { maxLength: 4 },
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
