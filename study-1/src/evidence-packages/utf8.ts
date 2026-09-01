const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string | undefined {
  let decoded = "";
  try {
    decoded = decoder.decode(bytes);
  } catch {
    return undefined;
  }
  return decoded;
}
