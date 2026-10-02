/** Audio for the voice assistant: mic capture as 16 kHz PCM frames and gapless
 *  playback of the model's 24 kHz PCM reply.
 *
 *  Both run in the webview on purpose (the dictation agent captures in Rust):
 *  getUserMedia's echo cancellation hears what this page plays, so the model
 *  doesn't interrupt itself when the user is on speakers. */

const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000;
const WORKLET_URL = "/voice-capture.worklet.js";
/** Head start for the first chunk of a reply, so network jitter between
 *  chunks doesn't turn into audible gaps. */
const PLAYBACK_LEAD_S = 0.06;

export const INPUT_MIME = `audio/pcm;rate=${INPUT_RATE}`;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class VoiceAudio {
  private stream: MediaStream | null = null;
  private inCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private outGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf: Uint8Array<ArrayBuffer> | null = null;
  private playing = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private micLevel = 0;
  private isMuted = false;

  /** `onFrame` gets each mic frame as base64 PCM; nothing is delivered while
   *  muted. Rejects when the mic is refused or missing. */
  async start(onFrame: (pcmBase64: string) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // A 16 kHz context makes the browser do the resampling, with a proper
    // low-pass, instead of a hand-rolled decimator in the worklet.
    this.inCtx = new AudioContext({ sampleRate: INPUT_RATE, latencyHint: "interactive" });
    await this.inCtx.audioWorklet.addModule(WORKLET_URL);
    const capture = new AudioWorkletNode(this.inCtx, "voice-capture", { numberOfOutputs: 0 });
    capture.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      if (this.isMuted) {
        this.micLevel = 0;
        return;
      }
      this.micLevel = e.data.level;
      onFrame(toBase64(new Uint8Array(e.data.pcm)));
    };
    this.inCtx.createMediaStreamSource(this.stream).connect(capture);
    this.startOutput();
  }

  /** The speaker side alone, for playback with no microphone (voice samples). */
  startOutput(): void {
    if (this.outCtx) return;
    this.outCtx = new AudioContext({ sampleRate: OUTPUT_RATE, latencyHint: "interactive" });
    this.outGain = this.outCtx.createGain();
    this.analyser = this.outCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.levelBuf = new Uint8Array(this.analyser.fftSize);
    this.outGain.connect(this.analyser).connect(this.outCtx.destination);
  }

  get muted(): boolean {
    return this.isMuted;
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    // Also at the source, so the OS mic indicator reflects it.
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !muted;
  }

  /** Queues a chunk of the reply (base64 16-bit PCM) right after the last. */
  play(pcmBase64: string): void {
    const ctx = this.outCtx;
    if (!ctx || !this.outGain) return;
    const bytes = fromBase64(pcmBase64);
    const pcm = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
    if (!pcm.length) return;
    const buffer = ctx.createBuffer(1, pcm.length, OUTPUT_RATE);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.outGain);
    const at = Math.max(this.nextAt, ctx.currentTime + PLAYBACK_LEAD_S);
    src.start(at);
    this.nextAt = at + buffer.duration;
    this.playing.add(src);
    src.onended = () => this.playing.delete(src);
  }

  /** Drops everything queued: the user talked over the reply. */
  flush(): void {
    for (const src of this.playing) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* not started yet */
      }
    }
    this.playing.clear();
    this.nextAt = 0;
  }

  /** True while queued reply audio is still coming out of the speakers. */
  get speaking(): boolean {
    return this.playing.size > 0;
  }

  /** Mic and reply loudness, 0..1 (RMS), for the orb. */
  levels(): { mic: number; out: number } {
    let out = 0;
    if (this.analyser && this.levelBuf && this.playing.size) {
      this.analyser.getByteTimeDomainData(this.levelBuf);
      let sum = 0;
      for (const v of this.levelBuf) sum += ((v - 128) / 128) ** 2;
      out = Math.sqrt(sum / this.levelBuf.length);
    }
    return { mic: this.micLevel, out };
  }

  close(): void {
    this.flush();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    void this.inCtx?.close().catch(() => {});
    void this.outCtx?.close().catch(() => {});
    this.stream = null;
    this.inCtx = this.outCtx = null;
    this.outGain = this.analyser = null;
    this.micLevel = 0;
  }
}
