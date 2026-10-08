// The execution-level evidence no trial owns (design §7 `readiness/`, `provider/`; D-10, addendum
// §2.2, A-09): the readiness canary's two journals, the provider warm-up journal and the provider's
// unattributed calls, exported once after the last trial and monitoring, before cleanup changes
// anything. They are supplementary evidence. The A-09 configuration item is collected too, but the
// layout (design §7) has no package path for it, so it is not packaged: no table export keeps it,
// and stack deletion removes it with the control table. Its identity and manifest digest are
// already in the package; only its `written_at` is lost (evidence/WP-27/decisions.md, residual).

import { collectExecutionEvidence } from '../evidence-collection/readiness-collection.ts';
import type { CollectorStoreReader } from '../evidence-collection/collected-records.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { AdmittedExecution } from './execution-ports.ts';
import type { ExecutionPackage } from './execution-package.ts';

/**
 * Exports the execution-level journals into the package; every read or write that failed.
 *
 * @example
 * const failures = await writeExecutionEvidence(store, admitted, pkg); // [] when all four were written
 */
export async function writeExecutionEvidence(
  store: CollectorStoreReader,
  admitted: AdmittedExecution,
  pkg: ExecutionPackage,
): Promise<readonly StructuredReason[]> {
  const collected = await collectExecutionEvidence(store, admitted.identity, admitted.manifest_sha256);
  const failures: StructuredReason[] = [...collected.failures];
  for (const file of collected.files) {
    const path = Object.hasOwn(EXECUTION_PATHS, file.key)
      ? EXECUTION_PATHS[file.key as keyof typeof EXECUTION_PATHS]
      : undefined;
    const unwritten = path === undefined ? undefined : await pkg.writeOnce(path, file.bytes);
    failures.push(...(unwritten === undefined ? [] : [unwritten]));
  }
  return failures;
}
