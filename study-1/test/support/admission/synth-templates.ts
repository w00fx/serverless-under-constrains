// The cloud assembly the scripted `cdk synth` writes for one execution (design §9.8 S1): the
// cloud-assembly manifest, the execution stack's template, its asset manifest and one bundled
// asset. The template is the WP-11 CDK-shaped execution template, so the transport scope
// recomputed from it is the one a probe of the same committed project froze.

import { stackName } from '../../../infra/ownership/resource-naming.ts';
import type { ExecutionKind, JsonObject, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { ScriptedAssemblyFile } from '../deployment-assembly/fake-command-runner.ts';
import { cdkTemplate } from '../../unit/transport-qualification/scope/support/scope-fixtures.ts';

const TEMPLATE_KIND: Readonly<Record<ExecutionKind, 'run' | 'probe' | 'validation'>> = {
  RUN: 'run',
  TRANSPORT_PROBE: 'probe',
  VARIANT_VALIDATION: 'validation',
};
const encoder = new TextEncoder();

/**
 * The synthesized execution-stack template of one execution.
 *
 * @example
 * synthTemplate('RUN', executionId).Resources; // the ExperimentCore and variant resources
 */
export function synthTemplate(kind: ExecutionKind, executionId: Uuid4): JsonObject {
  return cdkTemplate({ executionId, kind: TEMPLATE_KIND[kind] });
}

/**
 * The template a transport probe synthesized.
 *
 * @example
 * probeSynthTemplate(probeId);
 */
export function probeSynthTemplate(probeId: Uuid4): JsonObject {
  return synthTemplate('TRANSPORT_PROBE', probeId);
}

/**
 * The files `cdk synth --output <dir>` writes for one execution.
 *
 * @example
 * runner.scriptSynthOutput(synthesizedAssemblyFiles('RUN', executionId));
 */
export function synthesizedAssemblyFiles(kind: ExecutionKind, executionId: Uuid4): readonly ScriptedAssemblyFile[] {
  const stack = stackName(kind, executionId);
  return [
    { path: 'manifest.json', bytes: encoder.encode('{"version":"54.0.0"}\n'), mode: 0o644 },
    {
      path: `${stack}.template.json`,
      bytes: encoder.encode(`${JSON.stringify(synthTemplate(kind, executionId), null, 1)}\n`),
      mode: 0o644,
    },
    { path: `${stack}.assets.json`, bytes: encoder.encode('{"files":{},"dockerImages":{}}\n'), mode: 0o644 },
    { path: 'asset.0a1b2c3d/index.mjs', bytes: encoder.encode('export const handler = () => 1;\n'), mode: 0o644 },
  ];
}
