import type { EvidenceRef } from "../protocol-records/types.ts";
import { createEvidenceRefs } from "../protocol-records/records.ts";
import { sha256Hex } from "../protocol-records/serialize.ts";
import { isRecord } from "../protocol-records/primitives.ts";
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
  if (typeof value.event_id === "string") {
    ids.add(value.event_id);
  }
  for (const key of Object.keys(value)) {
    if (key !== "event_id") {
      addEventId(value[key], ids);
    }
  }
}

export function eventIdsIn(bytes: Uint8Array): Set<string> {
  const ids = new Set<string>();
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    return ids;
  }
  try {
    addEventId(JSON.parse(text), ids);
    return ids;
  } catch {
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    for (const line of lines) {
      if (line === "") {
        continue;
      }
      try {
        addEventId(JSON.parse(line), ids);
      } catch {
        continue;
      }
    }
  }
  return ids;
}

function parseJsonDocuments(bytes: Uint8Array): unknown[] {
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    return [];
  }
  try {
    return [JSON.parse(text)];
  } catch {
    const documents: unknown[] = [];
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    for (const line of lines) {
      if (line === "") {
        continue;
      }
      try {
        documents.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return documents;
  }
}

function refsInDocument(document: unknown): EvidenceRef[] | string[] {
  if (!isRecord(document) || document.evidence_refs === undefined) {
    return [];
  }
  const created = createEvidenceRefs(document.evidence_refs);
  return created.ok ? created.value : [...created.reasons];
}

export function collectReferenceReasons(
  store: PackageStore,
  packageIndexDigest: string,
): string[] {
  const reasons: string[] = [];
  const seen = new Map<string, string>();
  for (const path of store.keys()) {
    if (!isPackagePath(path)) {
      continue;
    }
    const bytes = storeBytes(store, path);
    if (bytes === undefined) {
      continue;
    }
    for (const document of parseJsonDocuments(bytes)) {
      const refs = refsInDocument(document);
      if (refs.length > 0 && typeof refs[0] === "string") {
        reasons.push(...(refs as string[]));
        continue;
      }
      for (const ref of refs as EvidenceRef[]) {
        const target = storeBytes(store, ref.artifact_path);
        if (target === undefined) {
          reasons.push("unresolved_reference");
          continue;
        }
        if (sha256Hex(target) !== ref.artifact_sha256) {
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
        if (ref.event_id !== undefined && !eventIdsIn(target).has(ref.event_id)) {
          reasons.push("missing_event");
        }
        if (ref.json_pointer !== undefined) {
          const text = decodeUtf8(target);
          if (text === undefined) {
            reasons.push("invalid_json_pointer");
            continue;
          }
          try {
            if (!jsonPointerExists(JSON.parse(text), ref.json_pointer)) {
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
