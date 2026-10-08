// `rua billing import <package> --export <dir>` (design §8.17, §11; BR-RUA-043, BR-RUA-047): imports
// one authoritative billing delivery into a BILLING amendment of a finalized package. In order:
//   1. the package operand and its frozen manifest (usage error / exit 5);
//   2. the delivery directory, read as untrusted bytes (usage error when it cannot be read);
//   3. the package's closure: first mutation and cleanup terminal instant (`package-closure.ts`);
//   4. the attribution inputs (`billing-context.ts`) and the delivery check (`billing-delivery.ts`):
//      a structural problem refuses the import (exit 5, nothing written);
//   5. `buildBillingImport` over the one data file's exact bytes, then demoted to `unverified` by
//      every scope, period, fact or attribution gap the export itself cannot show;
//   6. one amendment: `payload/billing-import.json` and the delivery's exact bytes under
//      `payload/billing-export/`, index last (`writeAmendmentPackage`).
// It never calls the cloud. Exit 0 once the amendment is written, whatever the check says: the
// billed-cost check is the record's answer, read later by the verifiers.

import { buildBillingImport } from '../billing-amendment/billing-import.ts';
import { writeAmendmentPackage } from '../execution-lifecycle/amendment-writer.ts';
import type { AdmittedExecution, ExecutionServices } from '../execution-lifecycle/execution-ports.ts';
import type { PackageFile, PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { AMENDMENT_PATHS } from '../evidence-package/package-layout.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonObject, Result, Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type { BillingImport } from '../record-contract/records/group-c/billing_import.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { readAdmittedPackage } from './admitted-package.ts';
import { amendmentRefusal, amendmentWrittenPath } from './amendment-report.ts';
import { flagValue, operandOf, usageReason } from './arg-parsing.ts';
import { billingContextOf, demotedBillingImport } from './billing-context.ts';
import type { DeliveryEntry } from './billing-delivery.ts';
import { checkDelivery } from './billing-delivery.ts';
import type { BillingFactTable } from './billing-facts.ts';
import { failedOutcome } from './cli-result.ts';
import type { CliCommand, CliOutcomeReport, CommandContext, CommandSpec, ParsedArgs } from './cli-types.ts';
import { readPackageClosure } from './package-closure.ts';

/** Reads every entry below a local directory (production: the file system). */
export interface DeliveryDirectoryReader {
  read(
    directory: string,
  ): Promise<Result<readonly DeliveryEntry[], { readonly code: string; readonly detail: string }>>;
}

/** What the command reads, writes and stamps the import with. */
export interface BillingImportCommandDeps {
  readonly files: (evidenceRoot: string) => PackageFileSystem;
  readonly deliveries: DeliveryDirectoryReader;
  readonly facts: BillingFactTable;
  readonly services: ExecutionServices;
}

/** The import record and the amendment payload that carries it with the delivery's bytes. */
interface BillingPayload {
  readonly record: BillingImport;
  readonly original_index_sha256: Sha256Hex;
  readonly payload: readonly PackageFile[];
}

const PACKAGE_OPERAND = 'package';
const EXPORT_FLAG = 'export';

/**
 * `billing import <package> --export <dir>`.
 *
 * @example
 * await main(['billing', 'import', 'evidence/runs/<id>', '--export', 'cur/2026-10'], io, root);
 */
export class BillingImportCommand implements CliCommand {
  readonly spec: CommandSpec = {
    words: ['billing', 'import'],
    positionals: [PACKAGE_OPERAND],
    flags: new Map([[EXPORT_FLAG, 'required']]),
    usage: `billing import <package> --${EXPORT_FLAG} <dir>`,
  };
  readonly #deps: BillingImportCommandDeps;

  constructor(deps: BillingImportCommandDeps) {
    this.#deps = deps;
  }

  async run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport> {
    const { services } = this.#deps;
    const files = this.#deps.files(context.evidence_root);
    const admitted = await readAdmittedPackage(operandOf(args, PACKAGE_OPERAND), context, {
      files,
      validator: services.validator,
    });
    if (!admitted.ok) {
      return admitted.error;
    }
    const directory = context.resolvePath(flagValue(args.flags, EXPORT_FLAG));
    const entries = await this.#deps.deliveries.read(directory);
    if (!entries.ok) {
      const problem = `--${EXPORT_FLAG} ${boundedJsonText(directory)} cannot be read (${entries.error.code}: ${entries.error.detail})`;
      return failedOutcome('usage_error', [usageReason(problem, 'a readable delivery directory')]);
    }
    const imported = await this.#billingImport(admitted.value, files, entries.value);
    if (!imported.ok) {
      return amendmentRefusal(admitted.value.identity, imported.error);
    }
    const { record, original_index_sha256: originalIndex, payload } = imported.value;
    context.progress(`billed-cost check ${record.billed_cost_check} for ${admitted.value.package_directory}`);
    const written = await writeAmendmentPackage(files, services, {
      admitted: admitted.value,
      kind: 'BILLING',
      original_index_sha256: originalIndex,
      payload,
      subject: 'BR-RUA-047',
    });
    if (!written.ok) {
      return amendmentRefusal(admitted.value.identity, written.error);
    }
    return {
      outcome: 'completed',
      execution: admitted.value.identity,
      written_paths: [amendmentWrittenPath(written.value)],
      result_record: record as unknown as JsonObject,
      reasons: [],
    };
  }

  // Steps 3-5 of the header: the demoted record and the payload that carries it.
  async #billingImport(
    admitted: AdmittedExecution,
    files: PackageFileSystem,
    entries: readonly DeliveryEntry[],
  ): Promise<Result<BillingPayload, readonly StructuredReason[]>> {
    const { services } = this.#deps;
    const closure = await readPackageClosure(files, admitted, services.validator);
    if (!closure.ok) {
      return err([closure.error]);
    }
    const billing = billingContextOf(admitted, closure.value, this.#deps.facts);
    if (!billing.ok) {
      return err([billing.error]);
    }
    const { input, window } = billing.value;
    const delivery = checkDelivery(entries, { account_id: input.account_id, window });
    if (!delivery.ok) {
      return err([delivery.error]);
    }
    const built = buildBillingImport({
      context: input,
      execution_manifest_sha256: admitted.manifest_sha256,
      original_package_index_sha256: closure.value.index_sha256,
      export_bytes: delivery.value.data_file.bytes,
      ceiling_usd: admitted.manifest.safety.ceiling_usd,
      imported_at: formatUtcMillis(services.clock.now()),
    });
    if (!built.ok) {
      return built;
    }
    const record = demotedBillingImport(built.value, [...billing.value.reasons, ...delivery.value.reasons]);
    const exportFiles = [delivery.value.manifest, delivery.value.data_file].map((file) => ({
      path: `${AMENDMENT_PATHS.billingExportDirectory}${file.path}`,
      bytes: file.bytes,
    }));
    return ok({
      record,
      original_index_sha256: closure.value.index_sha256,
      payload: [{ path: AMENDMENT_PATHS.billingImport, bytes: serializeRecordFile(record) }, ...exportFiles],
    });
  }
}
