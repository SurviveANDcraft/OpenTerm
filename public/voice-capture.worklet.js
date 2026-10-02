// Mic capture for the voice assistant (src/voice/audio.ts). Runs on the audio
// thread of a 16 kHz AudioContext: packs the mono float stream into 16-bit PCM
// frames of FRAME samples and posts each with its RMS level. Served from
// /public as a plain file because the app's CSP only loads worklets from
// 'self' (no blob: or data: modules).

const FRAME = 800; // 50 ms at 16 kHz

class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(FRAME);
    this.len = 0;
    this.sum = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sum += s * s;
      if (this.len === FRAME) {
        const pcm = this.buf.buffer;
        this.port.postMessage({ pcm, level: Math.sqrt(this.sum / FRAME) }, [pcm]);
        this.buf = new Int16Array(FRAME);
        this.len = 0;
        this.sum = 0;
      }
    }
    return true;
  }
}

registerProcessor("voice-capture", VoiceCapture);
