import { assert } from "./domain.js";
const enc = new TextEncoder();
const b64 = (b) => btoa(String.fromCharCode(...b));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const random = () =>
  b64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export async function hash(s) {
  return [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function seal(value, purpose, master) {
  const raw = unb64(master);
  assert(raw.length === 32, "INVALID_ENCRYPTION_KEY", 503);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(purpose) },
    key,
    enc.encode(value),
  );
  return `v1.${b64(iv)}.${b64(new Uint8Array(data))}`;
}
export async function open(value, purpose, master) {
  const [v, iv, data] = value.split(".");
  assert(v === "v1", "INVALID_CIPHERTEXT", 503);
  const key = await crypto.subtle.importKey(
    "raw",
    unb64(master),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(purpose) },
      key,
      unb64(data),
    ),
  );
}
export async function equalHash(a, b) {
  return (await hash(String(a))) === (await hash(String(b)));
}
