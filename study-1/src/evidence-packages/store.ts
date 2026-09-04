import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fail, ok, type ValidationResult } from "./result.ts";
import { isPackagePath } from "./paths.ts";
import { isNormalizedRelativePosixPath } from "../protocol-records/primitives.ts";
import { encodeUtf8 } from "./utf8.ts";
import type { PackageStore } from "./types.ts";

export function createPackageStore(): PackageStore {
  return new Map();
}

export function isPackageStore(value: unknown): value is PackageStore {
  return value instanceof Map;
}

export function storeBytes(store: PackageStore, path: string): Uint8Array | undefined {
  const bytes = store.get(path);
  return bytes instanceof Uint8Array ? bytes : undefined;
}

export function putUtf8(
  store: PackageStore,
  path: unknown,
  text: string,
): ValidationResult<Uint8Array> {
  if (!isPackagePath(path)) {
    return fail(["invalid_path"]);
  }
  const bytes = encodeUtf8(text);
  store.set(path, bytes);
  return ok(bytes);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function existingDirectory(root: string): boolean | undefined {
  try {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return false;
    }
    return true;
  } catch (error) {
    return isEnoent(error) ? undefined : false;
  }
}

function walkDir(
  root: string,
  dir: string,
  store: PackageStore,
  reasons: string[],
): void {
  for (const name of readdirSync(dir).toSorted()) {
    const abs = join(dir, name);
    const stat = lstatSync(abs);
    if (stat.isDirectory()) {
      walkDir(root, abs, store, reasons);
      continue;
    }
    if (stat.isFile() === false || stat.isSymbolicLink()) {
      reasons.push("invalid_path");
      continue;
    }
    const rel = relative(root, abs).split(sep).join("/");
    if (!isNormalizedRelativePosixPath(rel)) {
      reasons.push("invalid_path");
      continue;
    }
    store.set(rel, new Uint8Array(readFileSync(abs)));
  }
}

export function loadPackageDir(root: string): ValidationResult<PackageStore> {
  try {
    if (existingDirectory(root) !== true) {
      return fail(["invalid_path"]);
    }
    const store = createPackageStore();
    const reasons: string[] = [];
    walkDir(root, root, store, reasons);
    if (reasons.length > 0) {
      return fail(reasons);
    }
    return ok(store);
  } catch {
    return fail(["invalid_path"]);
  }
}

export function savePackageDir(store: PackageStore, root: string): ValidationResult<true> {
  if (!isPackageStore(store)) {
    return fail(["not_an_object"]);
  }
  try {
    const directory = existingDirectory(root);
    if (directory === false) {
      return fail(["invalid_path"]);
    }
    if (directory === undefined) {
      mkdirSync(root, { recursive: true });
    }
    for (const [path, bytes] of store) {
      if (!isPackagePath(path) || !(bytes instanceof Uint8Array)) {
        return fail(["invalid_path"]);
      }
      const abs = join(root, ...path.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    }
    return ok(true);
  } catch {
    return fail(["invalid_path"]);
  }
}
