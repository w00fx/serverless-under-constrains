// Admission step A12 (SAFETY, boundary OWNERSHIP_STRATEGY; BR-RUA-042, BR-RUA-050, design §9.8
// S1-S3, D-25): synthesize the execution's assembly exactly once into the attempt's staging
// directory, read it back and inventory it as the package will hold it
// (`admission/deployment-assembly`). The synthesized template is what A13 recomputes the transport
// scope from and what the manifest pins by digest. A failed synthesis, an unreadable assembly, a
// symlink, special file or container-image asset, or an unreadable template rejects admission:
// the execution could not prove which resources it would own.

import { sha256Hex } from '../record-contract/digests.ts';
import { describeJson, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import type { JsonObject, Sha256Hex, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { DeploymentAssemblyInventory } from '../record-contract/records/group-a/deployment_assembly_inventory.ts';
import type { ExecutionSynthContext } from '../../infra/ownership/execution-context.ts';
import type { AssemblyFileSystem } from '../deployment-assembly/assembly-file-system.ts';
import type { AssemblySynthesizer, SynthReport } from '../deployment-assembly/assembly-ports.ts';
import { inventoryAssembly } from '../evidence-package/assembly-inventory.ts';
import { EXECUTION_DIRECTORIES } from '../evidence-package/package-layout.ts';
import { admissionReason } from './admission-reason.ts';
import { readAssemblyDirectory } from './assembly-files.ts';
import type { AssemblyDirectory } from './assembly-files.ts';
import { failed, failedWithAll, passed } from './preflight-check.ts';
import type { CheckStatement, StepVerdict } from './preflight-check.ts';

/** `admission/deployment-assembly`: the package-relative directory of the frozen copy. */
export const FROZEN_ASSEMBLY_PATH = EXECUTION_DIRECTORIES.deploymentAssembly.slice(0, -1);

/** The synthesized assembly, ready to be copied into the package draft. */
export interface SynthesizedAssembly {
  readonly synth: SynthReport;
  readonly directory: AssemblyDirectory;
  readonly inventory: DeploymentAssemblyInventory;
  /** The parsed stack template. */
  readonly template: JsonObject;
  /** Package-relative path of the template inside the frozen copy. */
  readonly template_path: string;
  readonly template_sha256: Sha256Hex;
}

export interface AssemblyFreezePorts {
  readonly synthesizer: AssemblySynthesizer;
  readonly files: AssemblyFileSystem;
}

/**
 * Step A12: one synthesis into `stagingDir`, then the inventory and the template.
 *
 * @example
 * const verdict = await synthesizeAssembly(context, '/tmp/suc-staging/<attempt>', ports, at);
 * if (verdict.passed) verdict.value.inventory.inventory_sha256;
 */
export async function synthesizeAssembly(
  context: ExecutionSynthContext,
  stagingDir: string,
  ports: AssemblyFreezePorts,
  inventoriedAt: UtcMillis,
): Promise<StepVerdict<SynthesizedAssembly>> {
  const statement: CheckStatement = {
    subject: 'deployment_assembly',
    expected: { boundary: 'OWNERSHIP_STRATEGY', assembly_path: FROZEN_ASSEMBLY_PATH },
  };
  const synth = await ports.synthesizer.synthesize(context, stagingDir);
  if (!synth.ok) {
    return failed('SAFETY', statement, [synth.error]);
  }
  const directory = await readAssemblyDirectory(ports.files, synth.value.assembly_dir);
  if (!directory.ok) {
    return failed('SAFETY', statement, [directory.error]);
  }
  const inventory = inventoryAssembly({
    assembly_path: FROZEN_ASSEMBLY_PATH,
    entries: directory.value.entries,
    files: directory.value.files,
    inventoried_at: inventoriedAt,
  });
  if (!inventory.ok) {
    return failedWithAll('SAFETY', statement, inventory.error, inventoryRefused());
  }
  const template = templateOf(directory.value, synth.value.template_file);
  if (template.reason !== undefined) {
    return failed('SAFETY', statement, [template.reason]);
  }
  return passed(
    {
      synth: synth.value,
      directory: directory.value,
      inventory: inventory.value,
      template: template.object,
      template_path: `${FROZEN_ASSEMBLY_PATH}/${synth.value.template_file}`,
      template_sha256: template.sha256,
    },
    {
      ...statement,
      observed: { inventory_sha256: inventory.value.inventory_sha256, files: inventory.value.files.length },
    },
  );
}

type TemplateReading =
  | { readonly reason: undefined; readonly object: JsonObject; readonly sha256: Sha256Hex }
  | { readonly reason: StructuredReason };

function templateOf(directory: AssemblyDirectory, templateFile: string): TemplateReading {
  const file = directory.files.find((candidate) => candidate.path === templateFile);
  const parsed = file === undefined ? undefined : parseJsonDocument(file.bytes);
  if (file === undefined || parsed?.ok !== true || !isJsonObject(parsed.value)) {
    return {
      reason: admissionReason(
        'TEMPLATE_UNREADABLE',
        'BR-RUA-042',
        `template ${describeJson(templateFile)} is ${file === undefined ? 'absent' : 'not a JSON object'}; expected the synthesized stack template`,
      ),
    };
  }
  return { reason: undefined, object: parsed.value, sha256: sha256Hex(file.bytes) };
}

// `inventoryAssembly` always states why it refused; this keeps the rejection nonempty regardless.
function inventoryRefused(): StructuredReason {
  return admissionReason(
    'ASSEMBLY_NOT_INVENTORIED',
    'BR-RUA-042',
    'the inventory refused the assembly; expected an inventory',
  );
}
