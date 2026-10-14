/** API keys as the frontend sees them: saved or not, and where. The keys
 *  themselves stay in the OS keystore on the Rust side (src-tauri/src/secrets),
 *  which looks them up whenever it calls a provider. The only time a key
 *  crosses into the webview is while the user types one into Settings. */

import { invoke } from "@tauri-apps/api/core";

export type SecretName = "openrouter" | "gemini";
/** "plaintext" is a key an older version left in state.json that no keystore
 *  would take yet; the next launch tries again. */
export type SecretStorage = "credentialManager" | "encryptedFile" | "plaintext";

export interface SecretInfo {
  storage: SecretStorage;
  /** A few characters to recognise the key by, like `sk-or-v1-0e6…1c96`. */
  hint: string;
}

const status: Record<SecretName, SecretInfo | null> = { openrouter: null, gemini: null };
const listeners = new Set<() => void>();

/** Must run after `load_state`, which is what moves keys out of an older
 *  state.json into the keystore. */
export async function loadSecrets(): Promise<void> {
  try {
    Object.assign(status, await invoke<Record<SecretName, SecretInfo | null>>("secrets_status"));
  } catch (e) {
    console.error("Couldn't read the saved API keys:", e);
  }
}

export function hasSecret(name: SecretName): boolean {
  return status[name] !== null;
}

export function secretInfo(name: SecretName): SecretInfo | null {
  return status[name];
}

export function storageLabel(storage: SecretStorage): string {
  switch (storage) {
    case "credentialManager":
      return "Encrypted in Windows Credential Manager";
    case "encryptedFile":
      return "Encrypted with your Windows account";
    case "plaintext":
      return "Not encrypted yet: OpenTerm couldn't reach Windows' secure storage. Saving the key again retries";
  }
}

/** Called after a key is saved or removed. */
export function onSecretsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(name: SecretName, info: SecretInfo | null): void {
  status[name] = info;
  listeners.forEach((fn) => fn());
}

export async function saveSecret(name: SecretName, value: string): Promise<void> {
  changed(name, await invoke<SecretInfo>("secret_set", { name, value }));
}

export async function clearSecret(name: SecretName): Promise<void> {
  await invoke("secret_clear", { name });
  changed(name, null);
}

/** Checks `value` against the provider, or the saved key when it's omitted.
 *  Resolves with the key's name in the provider's account when it has one;
 *  rejects with the provider's own message. */
export function testSecret(name: SecretName, value?: string): Promise<string | null> {
  return invoke<string | null>("secret_test", { name, value: value?.trim() || null });
}
