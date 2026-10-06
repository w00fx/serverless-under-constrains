// Reasons reach the cleanup journal from ports cleanup does not control: an AWS adapter names a
// failure by its SDK error (`ResourceInUseException`), an evidence feature by its own words. A
// journal line whose reason breaks the `structured_reason` schema is unreadable on a re-run, so
// the step it records would run again forever (found by the AC-RUA-011 run-twice case). Every
// reason is therefore made schema-conforming before it is journaled:
// - `code` becomes UPPER_SNAKE (`ResourceInUseException` → `RESOURCE_IN_USE_EXCEPTION`);
// - an empty `subject` or `detail` is named as such;
// - `event_id` stays only when it is a UUIDv4, and `artifact_path` moves into the detail, because
//   cleanup cannot prove a port's path is package-relative.

import { isUuid4 } from '../record-contract/identifiers.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';

const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;
const EMPTY_FIELD = '(empty)';

/**
 * The reason with every field the `structured_reason` schema constrains made conforming.
 *
 * @example
 * conformingReason({ code: 'ResourceInUseException', subject: 'suc1-aaaaaaaa-control', detail: 'in use' }).code;
 * // 'RESOURCE_IN_USE_EXCEPTION'
 */
export function conformingReason(reason: StructuredReason): StructuredReason {
  const detail = reason.detail.length === 0 ? EMPTY_FIELD : reason.detail;
  const conforming: StructuredReason = {
    code: upperSnakeCode(reason.code),
    subject: reason.subject.length === 0 ? EMPTY_FIELD : reason.subject,
    detail: reason.artifact_path === undefined ? detail : `${detail} (artifact ${reason.artifact_path})`,
  };
  return isUuid4(reason.event_id) ? { ...conforming, event_id: reason.event_id } : conforming;
}

/**
 * An UPPER_SNAKE spelling of a code: word boundaries become underscores, other characters drop.
 *
 * @example
 * upperSnakeCode('ThrottlingException'); // 'THROTTLING_EXCEPTION'
 * upperSnakeCode('404'); // 'CODE_404'
 */
export function upperSnakeCode(code: string): string {
  if (UPPER_SNAKE.test(code)) {
    return code;
  }
  const words = code
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase()
    .split('_')
    .filter((word) => word.length > 0);
  const joined = words.join('_');
  return /^[A-Z]/.test(joined) ? joined : `CODE_${joined === '' ? 'UNNAMED' : joined}`;
}
