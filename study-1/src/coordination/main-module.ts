import { pathToFileURL } from "node:url";

export function isExecutedAsMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && moduleUrl === pathToFileURL(entry).href;
}
