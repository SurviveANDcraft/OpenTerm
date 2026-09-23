import { invoke, convertFileSrc } from "@tauri-apps/api/core";

/** Read-only preview kinds the file viewer can render in place of the editor. */
export type PreviewKind = "image" | "video" | "audio" | "pdf" | "docx" | "sheet" | "csv";

const IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "apng", "jfif", "svg"];
const VIDEO = ["mp4", "m4v", "webm", "ogv", "mov", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "3gp", "m2ts"];
const AUDIO = ["mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus", "wma"];
const SHEET = ["xlsx", "xlsm", "xlsb", "xls", "ods"];

/** Returns the preview kind for a filename, or null when it should open in the
 *  text editor instead. */
export function previewKindFor(name: string): PreviewKind | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === name.toLowerCase()) return null; // no extension at all
  if (IMAGE.includes(ext)) return "image";
  if (VIDEO.includes(ext)) return "video";
  if (AUDIO.includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "doc") return "docx";
  if (SHEET.includes(ext)) return "sheet";
  if (ext === "csv" || ext === "tsv") return "csv";
  return null;
}

export function isMarkdown(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ext === "md" || ext === "markdown" || ext === "mdx";
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function errorNode(message: string): HTMLElement {
  const err = document.createElement("div");
  err.className = "file-editor-error";
  err.textContent = message;
  return err;
}

/** Renders a sheet-like grid (from SheetJS' array-of-arrays) into a table. */
function sheetTable(rows: unknown[][]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "preview-sheet";
  const table = document.createElement("table");
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);

  rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    const head = document.createElement("th");
    head.className = "preview-sheet-rownum";
    head.textContent = String(i + 1);
    tr.appendChild(head);
    for (let c = 0; c < width; c++) {
      const td = document.createElement("td");
      const v = row[c];
      td.textContent = v === undefined || v === null ? "" : String(v);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  });

  wrap.appendChild(table);
  return wrap;
}

/** Read-only preview surface for images, video, audio, PDFs and Office docs.
 *  Lives in the file viewer's body, swapped in instead of the CodeMirror editor. */
export function createFilePreview() {
  const el = document.createElement("div");
  el.className = "file-preview";

  function reset(): void {
    // Pause any playing media before it's detached, so audio doesn't linger.
    el.querySelectorAll("video, audio").forEach((m) => (m as HTMLMediaElement).pause());
    el.replaceChildren();
  }

  async function open(path: string, name: string, kind: PreviewKind): Promise<void> {
    reset();
    const src = convertFileSrc(path);

    try {
      switch (kind) {
        case "image": {
          const img = document.createElement("img");
          img.className = "preview-image";
          img.src = src;
          img.alt = name;
          img.addEventListener("error", () => {
            reset();
            el.appendChild(errorNode("Can't display this image."));
          });
          // Click to toggle between fit-to-window and full resolution.
          img.addEventListener("click", () => img.classList.toggle("actual-size"));
          el.appendChild(img);
          return;
        }
        case "video": {
          const video = document.createElement("video");
          video.className = "preview-video";
          video.src = src;
          video.controls = true;
          video.addEventListener("error", () => {
            reset();
            el.appendChild(
              errorNode("Can't play this video — the codec isn't supported by the app's web view.")
            );
          });
          el.appendChild(video);
          return;
        }
        case "audio": {
          const box = document.createElement("div");
          box.className = "preview-audio";
          const audio = document.createElement("audio");
          audio.src = src;
          audio.controls = true;
          box.append(audio);
          el.appendChild(box);
          return;
        }
        case "pdf": {
          const frame = document.createElement("iframe");
          frame.className = "preview-pdf";
          frame.src = src;
          el.appendChild(frame);
          return;
        }
        case "docx": {
          if (name.toLowerCase().endsWith(".doc")) {
            el.appendChild(
              errorNode("Legacy .doc files can't be previewed. Save as .docx to view it here.")
            );
            return;
          }
          const [{ default: mammoth }, { default: DOMPurify }] = await Promise.all([
            import("mammoth/mammoth.browser"),
            import("dompurify"),
          ]);
          const b64 = await invoke<string>("read_file_base64", { path });
          const { value } = await mammoth.convertToHtml({
            arrayBuffer: b64ToBytes(b64).buffer as ArrayBuffer,
          });
          const doc = document.createElement("div");
          doc.className = "preview-doc";
          doc.innerHTML = DOMPurify.sanitize(value);
          el.appendChild(doc);
          return;
        }
        case "sheet":
        case "csv": {
          const XLSX = await import("xlsx");
          let book;
          if (kind === "csv") {
            const text = await invoke<string>("read_text_file", { path });
            book = XLSX.read(text, { type: "string", raw: false });
          } else {
            const b64 = await invoke<string>("read_file_base64", { path });
            book = XLSX.read(b64ToBytes(b64), { type: "array" });
          }

          const names = book.SheetNames;
          if (names.length === 0) {
            el.appendChild(errorNode("This workbook has no sheets."));
            return;
          }

          const body = document.createElement("div");
          body.className = "preview-sheet-body";

          const showSheet = (sheetName: string) => {
            const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheetName], {
              header: 1,
              defval: "",
              blankrows: false,
            });
            body.replaceChildren(sheetTable(rows));
          };

          if (names.length > 1) {
            const tabs = document.createElement("div");
            tabs.className = "preview-sheet-tabs";
            names.forEach((sheetName, i) => {
              const tab = document.createElement("button");
              tab.className = "preview-sheet-tab" + (i === 0 ? " active" : "");
              tab.textContent = sheetName;
              tab.addEventListener("click", () => {
                tabs.querySelectorAll(".preview-sheet-tab").forEach((b) => b.classList.remove("active"));
                tab.classList.add("active");
                showSheet(sheetName);
              });
              tabs.appendChild(tab);
            });
            el.appendChild(tabs);
          }

          el.appendChild(body);
          showSheet(names[0]);
          return;
        }
      }
    } catch (e) {
      reset();
      el.appendChild(errorNode(String(e)));
    }
  }

  return { el, open, reset };
}
