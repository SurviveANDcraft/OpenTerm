/** One Gemini Live conversation over a WebSocket: audio in, audio and tool
 *  calls out. This file is the wire protocol only; audio devices live in
 *  audio.ts and everything the user sees in voiceView.ts.
 *
 *  A connection lasts about 15 minutes of audio. The server announces the end
 *  (goAway) and hands out resumption handles as it goes, so the session
 *  reconnects by itself, between turns when it can, and the conversation
 *  carries on with its context intact. An unexpected drop takes the same path. */

import { INPUT_MIME } from "./audio";

const ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const DEFAULT_LIVE_MODEL = "gemini-3.8-live";
export const DEFAULT_VOICE = "Aoede";
export const VOICES = ["Aoede", "Charon", "Fenrir", "Kore", "Leda", "Orus", "Puck", "Zephyr"];

/** Unexpected drops retried in a row before the session gives up. */
const MAX_RETRIES = 3;
/** How long a goAway waits for the current turn to finish before reconnecting
 *  anyway. */
const ROLLOVER_GRACE_MS = 5000;
const SETUP_TIMEOUT_MS = 12_000;

export type LiveState = "connecting" | "ready" | "reconnecting" | "closed";

export interface LiveToolCall {
  id: string;
  name: string;
  /** JSON argument string, the shape the app's tool runners take. */
  arguments: string;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: unknown;
}

export interface LiveSetup {
  system: string;
  tools: FunctionDeclaration[];
}

export interface LiveConfig {
  apiKey: string;
  model: string;
  voice: string;
  /** Called on every (re)connect. `fresh` is true when the server won't have
   *  the earlier conversation (first connect, or a reconnect with no handle),
   *  so the caller can fold a recap into the system text. */
  setup(fresh: boolean): LiveSetup;
}

export interface LiveEvents {
  onState(state: LiveState): void;
  /** A chunk of the spoken reply, base64 24 kHz PCM. */
  onAudio(pcmBase64: string): void;
  /** Transcript fragments of what the user said and what the model says. */
  onInputText(text: string): void;
  onOutputText(text: string): void;
  /** The user talked over the reply: drop queued audio. */
  onInterrupted(): void;
  onTurnComplete(): void;
  onToolCalls(calls: LiveToolCall[]): void;
  onToolCancel(ids: string[]): void;
  /** The session can't continue. The socket is already closed. */
  onError(message: string): void;
}

interface ServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  toolCall?: { functionCalls?: { id?: string; name?: string; args?: unknown }[] };
  toolCallCancellation?: { ids?: string[] };
  goAway?: unknown;
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  error?: { message?: string };
}

export function friendlyLiveError(msg: string): string {
  if (/api key|API_KEY|unauthenticated|permission/i.test(msg)) return "Gemini rejected the API key. Check it in Settings, AI.";
  if (/quota|rate|exhausted|429/i.test(msg)) return "Gemini's rate limit or quota is used up. Wait a moment, or check your plan in AI Studio.";
  if (/not found|not supported|unsupported|invalid.*model/i.test(msg)) return `Gemini doesn't know this voice model. Check the model id in Settings, AI. (${msg})`;
  return msg;
}

export class LiveSession {
  private ws: WebSocket | null = null;
  private state: LiveState = "closed";
  private handle: string | null = null;
  private retries = 0;
  private inTurn = false;
  private rollover: number | null = null;
  private setupTimer: number | null = null;

  constructor(
    private readonly cfg: LiveConfig,
    private readonly ev: LiveEvents
  ) {}

  get ready(): boolean {
    return this.state === "ready";
  }

  connect(): void {
    this.open("connecting");
  }

  /** Ends the session for good; no events fire after this. */
  close(): void {
    this.setState("closed");
    this.clearTimers();
    this.detach();
  }

  sendAudio(pcmBase64: string): void {
    this.send({ realtimeInput: { audio: { data: pcmBase64, mimeType: INPUT_MIME } } });
  }

  /** The mic went quiet on purpose (muted): lets the server flush what it has
   *  buffered instead of waiting on more audio. */
  endAudioStream(): void {
    this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  /** A typed-in message, answered out loud like a spoken one. */
  sendText(text: string): void {
    this.send({ realtimeInput: { text } });
  }

  sendToolResults(results: { id: string; name: string; content: string }[]): void {
    this.send({
      toolResponse: {
        functionResponses: results.map((r) => ({ id: r.id, name: r.name, response: { result: r.content } })),
      },
    });
  }

  // ------------------------------------------------------------ connection

  private setState(next: LiveState): void {
    if (this.state === next) return;
    this.state = next;
    this.ev.onState(next);
  }

  private clearTimers(): void {
    if (this.rollover !== null) window.clearTimeout(this.rollover);
    if (this.setupTimer !== null) window.clearTimeout(this.setupTimer);
    this.rollover = this.setupTimer = null;
  }

  /** Lets go of the current socket without its close handler reacting. */
  private detach(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  private open(as: "connecting" | "reconnecting"): void {
    this.clearTimers();
    this.detach();
    this.inTurn = false;
    this.setState(as);
    const ws = new WebSocket(`${ENDPOINT}?key=${encodeURIComponent(this.cfg.apiKey)}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      const setup = this.cfg.setup(!this.handle);
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${this.cfg.model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.cfg.voice } } },
            },
            systemInstruction: { parts: [{ text: setup.system }] },
            tools: setup.tools.length ? [{ functionDeclarations: setup.tools }] : [],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            sessionResumption: this.handle ? { handle: this.handle } : {},
            contextWindowCompression: { slidingWindow: {} },
          },
        })
      );
    };
    ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      // The server sends its JSON in binary frames.
      const raw = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };
    ws.onclose = (e: CloseEvent) => this.dropped(e.reason || (e.code === 1006 ? "Couldn't reach Gemini. Check your connection." : `Connection closed (${e.code}).`));
    this.setupTimer = window.setTimeout(() => this.dropped("Gemini didn't answer in time."), SETUP_TIMEOUT_MS);
  }

  /** The socket went away without us asking. */
  private dropped(reason: string): void {
    if (this.state === "closed") return;
    // A refusal during setup (bad key, unknown model) won't get better by
    // retrying; neither will a drop with no way to pick the context back up.
    const hopeless = this.state === "connecting" || this.retries >= MAX_RETRIES;
    if (hopeless) {
      this.close();
      this.ev.onError(friendlyLiveError(reason));
      return;
    }
    // A reconnect that was itself refused: the handle may be what's wrong.
    // Start over without it; the caller's recap stands in for the context.
    if (this.state === "reconnecting") this.handle = null;
    this.retries++;
    this.clearTimers();
    this.detach();
    this.setState("reconnecting");
    this.rollover = window.setTimeout(() => this.open("reconnecting"), 400 * this.retries);
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.error?.message) {
      this.close();
      this.ev.onError(friendlyLiveError(msg.error.message));
      return;
    }
    if (msg.setupComplete) {
      if (this.setupTimer !== null) window.clearTimeout(this.setupTimer);
      this.setupTimer = null;
      this.retries = 0;
      this.setState("ready");
    }
    const up = msg.sessionResumptionUpdate;
    if (up?.newHandle && up.resumable !== false) this.handle = up.newHandle;
    if (msg.goAway) {
      // Reconnect between turns so no sentence is cut; the grace timer covers
      // a turn that outlasts the server's notice.
      if (!this.inTurn) this.open("reconnecting");
      else this.rollover ??= window.setTimeout(() => this.open("reconnecting"), ROLLOVER_GRACE_MS);
    }
    const calls = msg.toolCall?.functionCalls;
    if (calls?.length) {
      this.inTurn = true;
      this.ev.onToolCalls(
        calls.map((c, i) => ({
          id: c.id || `call_${i}`,
          name: c.name ?? "",
          arguments: JSON.stringify(c.args ?? {}),
        }))
      );
    }
    if (msg.toolCallCancellation?.ids?.length) this.ev.onToolCancel(msg.toolCallCancellation.ids);

    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) this.ev.onInputText(sc.inputTranscription.text);
    if (sc.interrupted) this.ev.onInterrupted();
    for (const part of sc.modelTurn?.parts ?? []) {
      const data = part.inlineData;
      if (data?.data && data.mimeType?.startsWith("audio/")) {
        this.inTurn = true;
        this.ev.onAudio(data.data);
      }
    }
    if (sc.outputTranscription?.text) this.ev.onOutputText(sc.outputTranscription.text);
    if (sc.turnComplete || sc.interrupted) {
      this.inTurn = false;
      if (sc.turnComplete) this.ev.onTurnComplete();
      if (this.rollover !== null) this.open("reconnecting");
    }
  }

  private send(payload: unknown): void {
    if (this.state === "ready" && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}
