// Entry point of the agent's overlay windows. Each window hosts one renderer
// and listens to a single ordered channel from the agent: JSON for state
// changes, 25 raw bytes for each level frame.

import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Anchor, GlowRenderer, NoticeKind, PillRenderer } from "./overlay";

type Message =
  | { t: "theme"; vars: Record<string, string> }
  | { t: "begin"; seq: number; anchor: Anchor; hint: boolean; maxSeconds: number }
  | { t: "thinking"; polishing: boolean }
  | { t: "status"; text: string }
  | { t: "done"; label: string }
  | { t: "cancel" }
  | { t: "clear" }
  | { t: "fade" }
  | { t: "notice"; seq: number; text: string; kind: NoticeKind; anchor: Anchor; clickable: boolean; morph: boolean }
  | { t: "preview"; seq: number; anchor: Anchor };

const isGlow = getCurrentWindow().label === "overlay-glow";
const finished = (seq: number) => void invoke("overlay_finished", { seq }).catch(() => {});

const pill = isGlow ? null : new PillRenderer(document.body);
const glow = isGlow ? new GlowRenderer(document.body) : null;
if (pill) {
  pill.onFinished = finished;
  pill.onClick = () => void invoke("overlay_click").catch(() => {});
}
if (glow) glow.onFinished = finished;

function handle(m: Message): void {
  switch (m.t) {
    case "theme":
      for (const [k, v] of Object.entries(m.vars)) document.documentElement.style.setProperty(k, v);
      pill?.refreshTheme();
      break;
    case "begin":
      pill?.begin(m);
      glow?.begin(m);
      break;
    case "thinking":
      pill?.thinking(m.polishing);
      glow?.thinking();
      break;
    case "status":
      pill?.status(m.text);
      break;
    case "done":
      pill?.done(m.label);
      glow?.done();
      break;
    case "cancel":
      pill?.cancel();
      glow?.fade();
      break;
    case "clear":
      pill?.hideNow();
      glow?.hideNow();
      break;
    case "fade":
      glow?.fade();
      break;
    case "notice":
      pill?.notice(m);
      break;
    case "preview":
      pill?.demo({ seq: m.seq, anchor: m.anchor, listen: 1.3, think: 0.8, loop: false });
      glow?.demo({ seq: m.seq, listen: 1.3, think: 0.8, loop: false });
      break;
  }
}

const channel = new Channel<Message | ArrayBuffer>();
channel.onmessage = (m) => {
  if (m instanceof ArrayBuffer) {
    const bytes = new Uint8Array(m);
    pill?.levels(bytes);
    glow?.levels(bytes);
  } else {
    handle(m);
  }
};
void invoke("overlay_attach", { channel });
