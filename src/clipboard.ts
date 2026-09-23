import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Clipboard access.
 *
 *  `navigator.clipboard` is unusable here: under the `tauri://` origin WebView2
 *  rejects both read and write without ever prompting, so the promise fails
 *  silently and nothing lands on the clipboard. The Tauri plugin talks to the
 *  OS clipboard from Rust instead. The `navigator` path stays as a fallback for
 *  `npm run dev` in a plain browser, where the plugin isn't there at all. */

export async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* no clipboard available */
    }
  }
}

export async function pasteText(): Promise<string> {
  try {
    return (await readText()) ?? "";
  } catch {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  }
}
