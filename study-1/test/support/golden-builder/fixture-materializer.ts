// Turns a golden case into its fixture bytes: build the base with the case's plan, apply the
// model operations, serialize with digest links resolved, then apply the byte operations. The same
// function feeds the generator (write once), its `--check` mode and the reproducibility golden, so
// a committed fixture is always exactly what its case file describes.

import type { Result } from '../../../src/record-contract/primitives.ts';
import type { ByteOperation } from './byte-operations.ts';
import { BYTE_OPERATION_NAMES, applyByteOperations } from './byte-operations.ts';
import type { FixtureBytes } from './digest-links.ts';
import { serializeScenarioFiles } from './digest-links.ts';
import type { GoldenCase } from './golden-case.ts';
import type { ScenarioOperation } from './operation-parsing.ts';
import { buildBaseScenario } from './scenario-builder.ts';
import type { ModelOperation } from './scenario-operations.ts';
import { applyModelOperations } from './scenario-operations.ts';

/**
 * The fixture bytes of a case, keyed by package-relative path; fails with every problem found.
 * Model operations run before serialization and byte operations after it, whatever their order in
 * the case.
 *
 * @example
 * const fixture = materializeCase(goldenCase);
 * if (fixture.ok) fixture.value.get('runner/runner-journal.jsonl');
 */
export function materializeCase(goldenCase: GoldenCase): Result<FixtureBytes, readonly string[]> {
  const built = buildBaseScenario(goldenCase.base, goldenCase.plan);
  if (!built.ok) {
    return { ok: false, error: built.error.map((problem) => `case.plan: ${problem}`) };
  }
  const subject = built.value.subject_directory;
  const edited = applyModelOperations(built.value.files, goldenCase.operations.filter(isModelOperation), subject);
  if (!edited.ok) {
    return { ok: false, error: [edited.error] };
  }
  const serialized = serializeScenarioFiles(edited.value);
  if (!serialized.ok) {
    return serialized;
  }
  const bytes = applyByteOperations(serialized.value, goldenCase.operations.filter(isByteOperation), subject);
  return bytes.ok ? bytes : { ok: false, error: [bytes.error] };
}

function isByteOperation(operation: ScenarioOperation): operation is ByteOperation {
  return (BYTE_OPERATION_NAMES as readonly string[]).includes(operation.op);
}

function isModelOperation(operation: ScenarioOperation): operation is ModelOperation {
  return !isByteOperation(operation);
}
