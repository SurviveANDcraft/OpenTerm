//! Start / stop / cancel cues. Synthesized once into memory (soft sine blips,
//! no asset files) and played on a dedicated thread that keeps the output
//! device open for a few seconds after use, so the start cue isn't late.

use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use rodio::buffer::SamplesBuffer;
use rodio::{OutputStream, OutputStreamHandle, Source};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cue {
    Start,
    Stop,
    Cancel,
}

enum Req {
    Prepare,
    Play(Cue),
}

const SR: u32 = 48_000;
const IDLE_CLOSE: Duration = Duration::from_secs(6);

/// A short note with a smooth attack and exponential tail.
fn note(out: &mut Vec<f32>, freq: f32, ms: u32, gain: f32) {
    let n = (SR * ms / 1000) as usize;
    let attack = (SR as usize * 6) / 1000;
    for i in 0..n {
        let t = i as f32 / SR as f32;
        let env = if i < attack {
            i as f32 / attack as f32
        } else {
            (-((i - attack) as f32) / n as f32 * 5.0).exp()
        } * ((n - i) as f32 / attack as f32).min(1.0); // no click at the tail
        // A quiet octave on top gives it a rounder, glassier tone.
        let s = (2.0 * std::f32::consts::PI * freq * t).sin() + 0.18 * (4.0 * std::f32::consts::PI * freq * t).sin();
        out.push(s * env * gain);
    }
}

fn synth(cue: Cue) -> Vec<f32> {
    let mut v = Vec::new();
    match cue {
        Cue::Start => {
            note(&mut v, 783.99, 70, 0.16);
            note(&mut v, 1174.66, 150, 0.14);
        }
        Cue::Stop => {
            note(&mut v, 1174.66, 60, 0.11);
            note(&mut v, 880.0, 140, 0.11);
        }
        Cue::Cancel => note(&mut v, 587.33, 130, 0.1),
    }
    v
}

fn sender() -> &'static Mutex<Sender<Req>> {
    static TX: OnceLock<Mutex<Sender<Req>>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Req>();
        thread::spawn(move || {
            let cues = [Cue::Start, Cue::Stop, Cue::Cancel].map(|c| (c, synth(c)));
            // OutputStream isn't Send, so it lives and dies on this thread.
            let mut out: Option<(OutputStream, OutputStreamHandle)> = None;
            loop {
                let req = match rx.recv_timeout(IDLE_CLOSE) {
                    Ok(r) => r,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        out = None;
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                };
                if out.is_none() {
                    out = OutputStream::try_default().ok();
                }
                if let (Req::Play(cue), Some((_, handle))) = (req, out.as_ref()) {
                    if let Some((_, samples)) = cues.iter().find(|(c, _)| *c == cue) {
                        let buf = SamplesBuffer::new(1, SR, samples.clone());
                        let _ = handle.play_raw(buf.convert_samples());
                    }
                }
            }
        });
        Mutex::new(tx)
    })
}

fn send(req: Req) {
    if let Ok(tx) = sender().lock() {
        let _ = tx.send(req);
    }
}

/// Opens the output device ahead of a cue that's about to play.
pub fn prepare() {
    send(Req::Prepare);
}

pub fn play(cue: Cue) {
    send(Req::Play(cue));
}
