// The cloud assembly the scripted `cdk synth` writes for one execution (design §9.8 S1): the
// cloud-assembly manifest, the execution stack's template, its asset manifest and one bundled
// asset. The template is the WP-11 CDK-shaped execution template, so the transport scope
// recomputed from it is the one a probe of the same committed project froze. The manifest
// declares the stack's BR-RUA-050 ownership tags where the pinned CDK writes them; the values are
// spelled out here instead of importing `infra/ownership/ownership-tags.ts` (which loads
// aws-cdk-lib), and `ownership-strategy.integration.test.ts` proves them equal to a real
// synthesis of the same context.

import { stackName } from '../../../infra/ownership/resource-naming.ts';
import type { ExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import type { ExecutionKind, JsonObject, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { formatUtcMillis } from '../../../src/record-contract/timestamps.ts';
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

/** How a scripted synthesis departs from the stack a real `cdk synth` writes. */
export interface SynthOutputOptions {
  /** The stack's `properties.tags`; `'absent'` leaves the member out (a stack without a tag strategy). */
  readonly stack_tags?: JsonObject | 'absent';
}

/**
 * The ownership tags the execution stack of `context` declares (BR-RUA-050, design §9.7).
 *
 * @example
 * synthesizedStackTags(context)['suc:run_id']; // context.execution_id
 */
export function synthesizedStackTags(context: ExecutionSynthContext): JsonObject {
  return {
    'suc:expires_at': formatUtcMillis(new Date(Date.parse(context.admitted_at) + context.total_target_ms)),
    'suc:managed_by': 'rua-operator-cli',
    'suc:project': 'serverless-under-constraints',
    'suc:run_id': context.execution_id,
    'suc:study_id': 'study-1',
  };
}

/**
 * The cloud assembly manifest `cdk synth` writes for the execution stack of `context`.
 *
 * @example
 * cloudAssemblyManifest(context, { stack_tags: 'absent' }); // a stack that declares no tags
 */
export function cloudAssemblyManifest(context: ExecutionSynthContext, options: SynthOutputOptions = {}): JsonObject {
  const stack = stackName(context.execution_kind, context.execution_id);
  const tags = options.stack_tags ?? synthesizedStackTags(context);
  return {
    version: '54.0.0',
    artifacts: {
      [stack]: {
        type: 'aws:cloudformation:stack',
        environment: `aws://${context.account}/${context.region}`,
        properties: { templateFile: `${stack}.template.json`, ...(tags === 'absent' ? {} : { tags }) },
      },
    },
  };
}

/**
 * The files `cdk synth --output <dir>` writes for the execution of `context`.
 *
 * @example
 * runner.scriptSynthOutput(synthesizedAssemblyFiles(context));
 */
export function synthesizedAssemblyFiles(
  context: ExecutionSynthContext,
  options: SynthOutputOptions = {},
): readonly ScriptedAssemblyFile[] {
  const { execution_kind: kind, execution_id: executionId } = context;
  const stack = stackName(kind, executionId);
  return [
    {
      path: 'manifest.json',
      bytes: encoder.encode(`${JSON.stringify(cloudAssemblyManifest(context, options))}\n`),
      mode: 0o644,
    },
    {
      path: `${stack}.template.json`,
      bytes: encoder.encode(`${JSON.stringify(synthTemplate(kind, executionId), null, 1)}\n`),
      mode: 0o644,
    },
    { path: `${stack}.assets.json`, bytes: encoder.encode('{"files":{},"dockerImages":{}}\n'), mode: 0o644 },
    { path: 'asset.0a1b2c3d/index.mjs', bytes: encoder.encode('export const handler = () => 1;\n'), mode: 0o644 },
  ];
}
