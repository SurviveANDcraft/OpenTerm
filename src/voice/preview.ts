/** Plays a one-line sample of a voice, for the picker in Settings. It runs a
 *  throwaway Live session on the same model the conversation uses, so what
 *  you hear is exactly what you get. */

import { VoiceAudio } from "./audio";
import { LiveSession } from "./liveSession";

const SAMPLE_TIMEOUT_MS = 20_000;

export interface VoicePreview {
  /** Settles when the sample has finished playing, or was stopped. */
  done: Promise<void>;
  stop(): void;
}

export function previewVoice(apiKey: string, model: string, voice: string): VoicePreview {
  const audio = new VoiceAudio();
  audio.startOutput();
  let finish: () => void = () => {};
  let fail: (err: Error) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  let drain: number | null = null;
  const stop = (): void => {
    if (drain !== null) window.clearInterval(drain);
    window.clearTimeout(timeout);
    session.close();
    audio.close();
    finish();
  };
  const session = new LiveSession(
    {
      apiKey,
      model,
      voice,
      setup: () => ({
        system: "You are a voice sample. Say the line you are given, word for word, in a friendly tone, and nothing else.",
        tools: [],
      }),
    },
    {
      onState: (state) => {
        if (state === "ready") session.sendText(`Say: "Hi, I'm ${voice}. This is how I sound in OpenTerm."`);
      },
      onAudio: (pcm) => audio.play(pcm),
      onInputText: () => {},
      onOutputText: () => {},
      onInterrupted: () => {},
      // The last chunks are still queued when the turn ends: let them play out.
      onTurnComplete: () => {
        drain ??= window.setInterval(() => {
          if (!audio.speaking) stop();
        }, 100);
      },
      onToolCalls: () => {},
      onToolCancel: () => {},
      onError: (message) => {
        stop();
        fail(new Error(message));
      },
    }
  );
  const timeout = window.setTimeout(stop, SAMPLE_TIMEOUT_MS);
  session.connect();
  return { done, stop };
}
