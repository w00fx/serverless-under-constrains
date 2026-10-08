// Where a package operand points (design §7, §11): a package is the directory
// `<evidence-root>/{runs|transport-probes|variant-validations}/<execution_id>`, so the operand
// alone names the execution, and every path a command writes stays relative to the evidence root.
// The operand is operator input: anything else (a path outside the root, a nested directory, a
// directory name that is not a lowercase UUIDv4) is refused as a usage error with the offending
// value and the expected shape.

import { isAbsolute, relative, sep } from 'node:path';

import { boundedJsonText } from '../record-contract/json-value.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  ExecutionIdentity,
  ExecutionKind,
  Result,
  StructuredReason,
  Uuid4,
} from '../record-contract/primitives.ts';
import { usageReason } from './arg-parsing.ts';

const KIND_DIRECTORIES: ReadonlyMap<string, ExecutionKind> = new Map([
  ['runs', 'RUN'],
  ['transport-probes', 'TRANSPORT_PROBE'],
  ['variant-validations', 'VARIANT_VALIDATION'],
]);

const EXPECTED_SHAPE = '<evidence-root>/{runs|transport-probes|variant-validations}/<lowercase uuid4>';

/**
 * The execution a package directory belongs to; both paths are absolute.
 *
 * @example
 * locatePackage('/s/evidence', '/s/evidence/runs/0b6d…'); // { ok: true, value: { execution_kind: 'RUN', run_id: '0b6d…' } }
 */
export function locatePackage(evidenceRoot: string, packagePath: string): Result<ExecutionIdentity, StructuredReason> {
  const inside = relative(evidenceRoot, packagePath);
  const parts = inside.split(sep);
  const [directory = '', id = ''] = parts;
  const kind = KIND_DIRECTORIES.get(directory);
  if (isAbsolute(inside) || parts.length !== 2 || kind === undefined || !isUuid4(id)) {
    return err(usageReason(`package ${boundedJsonText(packagePath)} is not a package directory`, EXPECTED_SHAPE));
  }
  return ok(identityOfKind(kind, id));
}

/**
 * The package's execution, refused when it is not of the kind the command handles.
 *
 * @example
 * locatePackageOfKind(root, '/s/evidence/runs/0b6d…', 'TRANSPORT_PROBE'); // usage error: a run is not a probe
 */
export function locatePackageOfKind(
  evidenceRoot: string,
  packagePath: string,
  kind: ExecutionKind,
): Result<ExecutionIdentity, StructuredReason> {
  const located = locatePackage(evidenceRoot, packagePath);
  if (!located.ok || located.value.execution_kind === kind) {
    return located;
  }
  return err(
    usageReason(
      `package ${boundedJsonText(packagePath)} is a ${located.value.execution_kind} package`,
      `a ${kind} package`,
    ),
  );
}

function identityOfKind(kind: ExecutionKind, id: Uuid4): ExecutionIdentity {
  switch (kind) {
    case 'RUN':
      return { execution_kind: 'RUN', run_id: id };
    case 'TRANSPORT_PROBE':
      return { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: id };
    case 'VARIANT_VALIDATION':
      return { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: id };
  }
}
