// The outputs file `cdk deploy --outputs-file` writes (design §9.8 D2): one JSON object keyed by
// stack name, each holding that stack's outputs as `key: string value`. The file comes from a
// subprocess and is read as untrusted bytes: the parser is total (A-05), reads own members only,
// and accepts exactly one stack, the deployed one, whose output keys are CloudFormation logical
// names (letters and digits) with string values, as the resource manifest records them.

import { boundedJsonText, describeJson, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonObject, Result, StructuredReason } from '../record-contract/primitives.ts';
import type { KeyValueEntry } from '../record-contract/records/group-a/resource_manifest.ts';
import { deploymentReason } from './deployment-reasons.ts';

const OUTPUT_KEY_PATTERN = /^[A-Za-z0-9]+$/;

/**
 * The outputs of `stackName`, sorted by key, or the first reason the file is not that stack's
 * outputs file.
 *
 * @example
 * parseStackOutputs(new TextEncoder().encode('{"SucRua-run-3f1c2a9e":{"ProviderVersion":"7"}}'), 'SucRua-run-3f1c2a9e');
 * // { ok: true, value: [{ key: 'ProviderVersion', value: '7' }] }
 */
export function parseStackOutputs(bytes: Uint8Array, stackName: string): Result<KeyValueEntry[], StructuredReason> {
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    const shown = parsed.ok ? describeJson(parsed.value) : 'not one UTF-8 JSON document';
    return err(outputsReason(`the outputs file is ${shown}; expected a JSON object keyed by stack name`));
  }
  const stacks = Object.keys(parsed.value);
  const outputs = Object.hasOwn(parsed.value, stackName) ? parsed.value[stackName] : undefined;
  if (stacks.length !== 1 || !isJsonObject(outputs)) {
    return err(
      outputsReason(
        `the outputs file names stacks ${boundedJsonText(stacks)}; expected exactly ${boundedJsonText(stackName)} mapped to an object`,
      ),
    );
  }
  return outputEntries(outputs);
}

function outputEntries(outputs: JsonObject): Result<KeyValueEntry[], StructuredReason> {
  const entries: KeyValueEntry[] = [];
  for (const [key, value] of Object.entries(outputs)) {
    if (!OUTPUT_KEY_PATTERN.test(key) || typeof value !== 'string') {
      return err(
        outputsReason(
          `output ${boundedJsonText(key)} is ${describeJson(value)}; expected a key of letters and digits with a string value`,
        ),
      );
    }
    entries.push({ key, value });
  }
  return ok(entries.toSorted((a, b) => (a.key < b.key ? -1 : 1)));
}

function outputsReason(detail: string): StructuredReason {
  return deploymentReason('OUTPUTS_UNREADABLE', 'BR-RUA-040', detail);
}
