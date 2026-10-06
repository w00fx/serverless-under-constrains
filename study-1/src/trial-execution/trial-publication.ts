// Phase T6 "build and validate message bytes; publish" (design §10.2, BR-RUA-020, BR-RUA-036).
// The canonical trial message is built from the frozen manifest, checked byte for byte before
// publication (a mismatch rejects setup and starts no trial), written once as
// `inputs/published-message.json`, and sent with the trial id as both the message group id and
// the deduplication id. The runner then journals `trial_message_published` with what SQS returned.
//
// A definitive send rejection starts no trial. An ambiguous send may have put the message on the
// queue, so the trial counts as started: it is observed, collected and frozen like any other, and
// the missing `trial_message_published` leaves its traceability for ingestion to judge (D-29).

import { sha256Hex } from '../record-contract/digests.ts';
import type { Sha256Hex, StructuredReason, UtcMillis, WallClock } from '../record-contract/primitives.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { buildTrialMessage, validateBeforePublication } from '../trial-message/trial-message-publication.ts';
import type { RunnerTrialJournal } from './runner-trial-journal.ts';
import type { TrialPlan, TrialMessagePublisher } from './trial-execution-ports.ts';
import { writeTrialFile } from './trial-inputs.ts';
import type { TrialFileTarget } from './trial-inputs.ts';

/** What T6 needs. */
export interface TrialPublicationContext {
  readonly publisher: TrialMessagePublisher;
  readonly target: TrialFileTarget;
  readonly journal: RunnerTrialJournal;
  readonly clock: WallClock;
  readonly validator: RecordValidator;
  readonly plan: TrialPlan;
  readonly manifest: TrialManifest;
  readonly manifest_sha256: Sha256Hex;
}

/**
 * - `published`: the trial started at `published_at`; `failures` holds an unwritten runner event;
 * - `not_published`: no message can be on the queue, no trial started.
 */
export type TrialPublicationOutcome =
  | { readonly kind: 'published'; readonly published_at: UtcMillis; readonly failures: readonly StructuredReason[] }
  | { readonly kind: 'not_published'; readonly reasons: readonly StructuredReason[] };

const SUBJECT = 'BR-RUA-036';

/**
 * Validates, records and publishes the trial message (T6).
 *
 * @example
 * const outcome = await publishTrialMessage(context);
 * if (outcome.kind === 'published') observeFrom(outcome.published_at);
 */
export async function publishTrialMessage(context: TrialPublicationContext): Promise<TrialPublicationOutcome> {
  const { plan } = context;
  const publication = {
    trial: context.manifest,
    trial_manifest_sha256: context.manifest_sha256,
    request: context.plan.approved_decision,
  };
  const { bytes } = buildTrialMessage(publication);
  const mismatches = validateBeforePublication(bytes, publication, context.validator);
  if (mismatches.length > 0) {
    return { kind: 'not_published', reasons: mismatches };
  }
  const unwritten = await writeTrialFile(context.target, plan.trial.trial_id, 'publishedMessage', bytes);
  if (unwritten !== undefined) {
    return { kind: 'not_published', reasons: [unwritten] };
  }
  const trialId = plan.trial.trial_id;
  const sent = await context.publisher.publish({
    queue_url: plan.queues.source.queue_url,
    body: new TextDecoder().decode(bytes),
    message_group_id: trialId,
    message_deduplication_id: trialId,
  });
  if (sent.kind === 'rejected') {
    return {
      kind: 'not_published',
      reasons: [sendReason('TRIAL_MESSAGE_NOT_SENT', `the send was rejected with ${sent.code}`)],
    };
  }
  if (sent.kind === 'ambiguous') {
    return {
      kind: 'published',
      published_at: formatUtcMillis(context.clock.now()),
      failures: [sendReason('TRIAL_MESSAGE_SEND_AMBIGUOUS', `the send settled ambiguously with ${sent.code}`)],
    };
  }
  const written = await context.journal.record('trial_message_published', {
    variant_id: plan.trial.variant_id,
    message_id: sent.message_id,
    sequence_number: sent.sequence_number,
    md5_of_message_body: sent.md5_of_message_body,
    message_body_sha256: sha256Hex(bytes),
    message_group_id: trialId,
    message_deduplication_id: trialId,
  });
  return written.ok
    ? { kind: 'published', published_at: written.value.occurred_at, failures: [] }
    : { kind: 'published', published_at: formatUtcMillis(context.clock.now()), failures: [written.error] };
}

function sendReason(code: string, problem: string): StructuredReason {
  return { code, subject: SUBJECT, detail: `${problem}; expected SQS to accept the trial message once` };
}
