/** Files attached to a question in the Agents panel chat. The assistant gets
 *  the file's content, not just its path: text as it is, Word documents as
 *  their text, spreadsheets as CSV per sheet. Formats with no text to extract
 *  here (PDF, images, media, archives) go along as a path only, and the model
 *  is told so instead of being left to guess at the content. */

import { invoke } from "@tauri-apps/api/core";

export interface ChatFile {
  path: string;
  name: string;
}

/** Per file, so one big log can't crowd out the rest of the request. */
const MAX_FILE_CHARS = 12_000;
const SHEETS = ["xlsx", "xlsm", "xlsb", "xls", "ods"];
const OPAQUE = /^(pdf|png|jpe?g|gif|webp|bmp|ico|avif|mp4|mov|mkv|webm|mp3|wav|ogg|flac|zip|7z|rar|gz|tar|exe|dll|doc|ppt|pptx)$/;

export function chatFile(path: string): ChatFile {
  return { path, name: path.split(/[\\/]/).filter(Boolean).pop() ?? path };
}

function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function extract(path: string, ext: string): Promise<string> {
  if (ext === "docx") {
    const { default: mammoth } = await import("mammoth/mammoth.browser");
    const data = bytes(await invoke<string>("read_file_base64", { path }));
    return (await mammoth.extractRawText({ arrayBuffer: data.buffer as ArrayBuffer })).value;
  }
  if (SHEETS.includes(ext)) {
    const XLSX = await import("xlsx");
    const book = XLSX.read(bytes(await invoke<string>("read_file_base64", { path })), { type: "array" });
    return book.SheetNames.map((n) => `# Sheet: ${n}\n${XLSX.utils.sheet_to_csv(book.Sheets[n])}`).join("\n\n");
  }
  return invoke<string>("read_text_file", { path });
}

/** The <file> block that rides with the question. Never throws: a file that
 *  can't be read is reported to the model as such. */
export async function fileBlock(file: ChatFile): Promise<string> {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  const open = `<file name="${file.name.replace(/"/g, "'")}" path="${file.path.replace(/"/g, "'")}"`;
  if (OPAQUE.test(ext))
    return `${open} content="not readable">\n(This ${ext.toUpperCase()} file's content can't be read here. You only know its name and path. Say so if the question depends on what's inside.)\n</file>`;
  try {
    const text = (await extract(file.path, ext)).trim();
    const clipped = text.length > MAX_FILE_CHARS;
    return `${open}${clipped ? ` truncated="first ${MAX_FILE_CHARS} of ${text.length} characters"` : ""}>\n${
      clipped ? text.slice(0, MAX_FILE_CHARS) + "\n…" : text || "(empty file)"
    }\n</file>`;
  } catch (err) {
    return `${open} content="not readable">\n(Couldn't read this file: ${String(err instanceof Error ? err.message : err)})\n</file>`;
  }
}
