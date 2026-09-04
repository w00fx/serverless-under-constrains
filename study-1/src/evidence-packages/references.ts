import type { EvidenceRef } from "../protocol-records/types.ts";
import { createEvidenceRefs } from "../protocol-records/records.ts";
import { sha256Hex } from "../protocol-records/serialize.ts";
import { isRecord } from "../protocol-records/primitives.ts";
import { ok, type ValidationResult } from "./result.ts";
import { isPackagePath } from "./paths.ts";
import { storeBytes } from "./store.ts";
import type { PackageStore } from "./types.ts";
import { decodeUtf8 } from "./utf8.ts";

export function jsonPointerExists(document: unknown, pointer: string): boolean {
  if (pointer === "") {
    return true;
  }
  if (!pointer.startsWith("/")) {
    return false;
  }
  let current: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) {
        return false;
      }
      const index = Number(token);
      if (index >= current.length) {
        return false;
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, token)) {
      return false;
    }
    current = current[token];
  }
  return true;
}

function addEventId(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      addEventId(item, ids);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === "evidence_refs") {
      continue;
    }
    if (key === "event_id" && typeof nested === "string") {
      ids.add(nested);
      continue;
    }
    addEventId(nested, ids);
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function parseJsonlDocuments(text: string): unknown[] {
  return text.split("\n").map(parseJsonLine);
}

function parseJsonDocuments(bytes: Uint8Array): unknown[] {
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    return parseJsonlDocuments("");
  }
  const parsed = parseJsonLine(text);
  return parsed === undefined ? parseJsonlDocuments(text) : [parsed];
}

export function eventIdsIn(bytes: Uint8Array): Set<string> {
  const ids = new Set<string>();
  for (const document of parseJsonDocuments(bytes)) {
    addEventId(document, ids);
  }
  return ids;
}

function refsInDocument(document: unknown): ValidationResult<EvidenceRef[]> {
  if (!isRecord(document) || document.evidence_refs === undefined) {
    return ok([]);
  }
  return createEvidenceRefs(document.evidence_refs);
}

export function collectReferenceReasons(
  store: PackageStore,
  packageIndexDigest: string,
): string[] {
  const reasons: string[] = [];
  const seen = new Map<string, string>();
  const documentsByPath = new Map<string, unknown[]>();
  const digestByPath = new Map<string, string>();
  const eventIdsByPath = new Map<string, Set<string>>();
  const documentsOf = (path: string, bytes: Uint8Array): unknown[] => {
    let documents = documentsByPath.get(path);
    if (documents === undefined) {
      documents = parseJsonDocuments(bytes);
      documentsByPath.set(path, documents);
    }
    return documents;
  };
  const digestOf = (path: string, bytes: Uint8Array): string => {
    let digest = digestByPath.get(path);
    if (digest === undefined) {
      digest = sha256Hex(bytes);
      digestByPath.set(path, digest);
    }
    return digest;
  };
  const eventIdsOf = (path: string, bytes: Uint8Array): Set<string> => {
    let ids = eventIdsByPath.get(path);
    if (ids === undefined) {
      ids = new Set<string>();
      for (const document of documentsOf(path, bytes)) {
        addEventId(document, ids);
      }
      eventIdsByPath.set(path, ids);
    }
    return ids;
  };
  for (const path of store.keys()) {
    if (!isPackagePath(path)) {
      continue;
    }
    const bytes = storeBytes(store, path) ?? new Uint8Array();
    for (const document of documentsOf(path, bytes)) {
      const refs = refsInDocument(document);
      if (!refs.ok) {
        reasons.push(...refs.reasons);
        continue;
      }
      for (const ref of refs.value) {
        const target = storeBytes(store, ref.artifact_path);
        if (target === undefined) {
          reasons.push("unresolved_reference");
          continue;
        }
        if (digestOf(ref.artifact_path, target) !== ref.artifact_sha256) {
          reasons.push("unresolved_reference");
        }
        const previous = seen.get(ref.artifact_path);
        if (previous !== undefined && previous !== ref.artifact_sha256) {
          reasons.push("conflicting_reference");
        }
        seen.set(ref.artifact_path, ref.artifact_sha256);
        if (
          ref.package_index_sha256 !== undefined &&
          ref.package_index_sha256 !== packageIndexDigest
        ) {
          reasons.push("unresolved_reference");
        }
        if (ref.event_id !== undefined && !eventIdsOf(ref.artifact_path, target).has(ref.event_id)) {
          reasons.push("missing_event");
        }
        if (ref.json_pointer !== undefined) {
          try {
            if (!jsonPointerExists(JSON.parse(String(decodeUtf8(target))), ref.json_pointer)) {
              reasons.push("unresolved_reference");
            }
          } catch {
            reasons.push("invalid_json_pointer");
          }
        }
      }
    }
  }
  return reasons;
}
