//! Microphone capture: cpal (WASAPI) on the chosen device, downmixed to mono,
//! resampled to 16 kHz and kept as i16, plus the live level bands the overlay
//! and the Settings meter draw.
//!
//! The mic is opened per recording and closed right after, so the Windows mic
//! indicator only shows while someone is actually dictating.

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};
use rubato::{FftFixedIn, Resampler};

pub const RATE: usize = 16_000;
pub const BANDS: usize = 24;
/// 24 band levels + 1 overall RMS, each 0..=255.
pub type Levels = [u8; BANDS + 1];
pub type LevelSink = Box<dyn FnMut(&Levels) + Send>;

const FFT_LEN: usize = 512;
const LEVEL_INTERVAL: Duration = Duration::from_micros(16_667);
/// RMS window used for loudness and silence detection (50 ms).
const RMS_WINDOW: usize = RATE / 20;
/// Below this peak RMS (about -45 dBFS) a recording holds no speech.
pub const SILENCE_RMS: f32 = 0.0056;

#[derive(Debug, Clone, PartialEq)]
pub enum CaptureError {
    /// Windows privacy settings deny microphone access.
    Blocked,
    NoDevice,
    Failed(String),
}

pub struct Recording {
    pub samples: Vec<i16>,
    pub peak_rms: f32,
}

impl Recording {
    pub fn duration_ms(&self) -> u64 {
        (self.samples.len() * 1000 / RATE) as u64
    }
}

pub struct Capture {
    stop: Sender<()>,
    join: Option<JoinHandle<Result<Recording, CaptureError>>>,
}

impl Capture {
    /// Starts capturing right away on a dedicated thread. `on_error` fires once
    /// if the device can't be opened, so the caller can say why immediately
    /// instead of at the end of the recording. `keep_secs` pre-sizes the
    /// buffer (0 = meter only, nothing kept).
    pub fn start(
        device: Option<String>,
        keep_secs: usize,
        sink: LevelSink,
        on_error: Box<dyn FnOnce(CaptureError) + Send>,
    ) -> Capture {
        let (stop, stop_rx) = mpsc::channel();
        let join = thread::spawn(move || {
            let res = run(device, keep_secs, sink, stop_rx);
            if let Err(e) = &res {
                on_error(e.clone());
            }
            res
        });
        Capture { stop, join: Some(join) }
    }

    pub fn stop(mut self) -> Result<Recording, CaptureError> {
        let _ = self.stop.send(());
        match self.join.take().map(JoinHandle::join) {
            Some(Ok(res)) => res,
            _ => Err(CaptureError::Failed("capture thread panicked".into())),
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        // A dropped (discarded) capture still has to release the mic.
        let _ = self.stop.send(());
    }
}

/// Input device names, default device first is up to the caller.
pub fn device_names() -> Vec<String> {
    let host = cpal::default_host();
    match host.input_devices() {
        Ok(devs) => devs.filter_map(|d| d.name().ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// Windows keeps the microphone privacy switches here: the global one and
/// the one for desktop (non-packaged) apps.
fn mic_blocked_by_privacy() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    [BASE.to_string(), format!(r"{BASE}\NonPackaged")].iter().any(|path| {
        hkcu.open_subkey(path)
            .and_then(|k| k.get_value::<String, _>("Value"))
            .is_ok_and(|v| v.eq_ignore_ascii_case("Deny"))
    })
}

fn classify(msg: String) -> CaptureError {
    let lower = msg.to_lowercase();
    if lower.contains("denied") || lower.contains("0x80070005") {
        CaptureError::Blocked
    } else {
        CaptureError::Failed(msg)
    }
}

fn run(
    device_name: Option<String>,
    keep_secs: usize,
    mut sink: LevelSink,
    stop: Receiver<()>,
) -> Result<Recording, CaptureError> {
    if mic_blocked_by_privacy() {
        return Err(CaptureError::Blocked);
    }
    let host = cpal::default_host();
    // A saved device that's gone (unplugged headset) falls back to the default.
    let device = device_name
        .and_then(|name| {
            host.input_devices()
                .ok()?
                .find(|d| d.name().is_ok_and(|n| n == name))
        })
        .or_else(|| host.default_input_device())
        .ok_or(CaptureError::NoDevice)?;
    let supported = device.default_input_config().map_err(|e| classify(e.to_string()))?;
    let channels = supported.channels() as usize;
    let in_rate = supported.sample_rate().0 as usize;
    let config: cpal::StreamConfig = supported.config();

    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let err_fn = |_e: cpal::StreamError| {};
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _: &_| {
                let _ = tx.send(downmix(data, channels, |s| s));
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _: &_| {
                let _ = tx.send(downmix(data, channels, |s| s as f32 / 32768.0));
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_input_stream(
            &config,
            move |data: &[i32], _: &_| {
                let _ = tx.send(downmix(data, channels, |s| s as f32 / 2147483648.0));
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _: &_| {
                let _ = tx.send(downmix(data, channels, |s| (s as f32 - 32768.0) / 32768.0));
            },
            err_fn,
            None,
        ),
        other => return Err(CaptureError::Failed(format!("unsupported sample format {other}"))),
    }
    .map_err(|e| classify(e.to_string()))?;
    stream.play().map_err(|e| classify(e.to_string()))?;
    let mut stream = Some(stream);

    let mut resampler = if in_rate == RATE {
        None
    } else {
        Some(
            FftFixedIn::<f32>::new(in_rate, RATE, in_rate / 50, 2, 1)
                .map_err(|e| CaptureError::Failed(e.to_string()))?,
        )
    };
    let mut pending: Vec<f32> = Vec::new();
    let mut out_buf = vec![vec![0f32; resampler.as_ref().map_or(0, |r| r.output_frames_max())]];
    let mut samples: Vec<i16> = Vec::with_capacity(keep_secs * RATE);
    // Meter mode keeps only a short tail for analysis.
    let keep = keep_secs > 0;
    let mut analyzer = Analyzer::new();
    let mut peak_rms = 0f32;
    let mut last_emit = Instant::now();

    let push = |chunk: &[f32], samples: &mut Vec<i16>| {
        samples.extend(chunk.iter().map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16));
        if !keep && samples.len() > FFT_LEN * 4 {
            samples.drain(..samples.len() - FFT_LEN);
        }
    };

    let mut stopping = false;
    loop {
        if !matches!(stop.try_recv(), Err(mpsc::TryRecvError::Empty)) {
            stopping = true;
        }
        if stopping {
            // Stop the device first, then drain what it already delivered.
            drop(stream.take());
            while let Ok(block) = rx.try_recv() {
                pending.extend_from_slice(&block);
            }
        } else {
            match rx.recv_timeout(Duration::from_millis(10)) {
                Ok(block) => pending.extend_from_slice(&block),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => stopping = true,
            }
        }

        match resampler.as_mut() {
            None => {
                push(&pending, &mut samples);
                pending.clear();
            }
            Some(r) => {
                while pending.len() >= r.input_frames_next() {
                    let need = r.input_frames_next();
                    if let Ok((_, n)) = r.process_into_buffer(&[&pending[..need]], &mut out_buf, None) {
                        push(&out_buf[0][..n], &mut samples);
                    }
                    pending.drain(..need);
                }
                if stopping {
                    let rest: Option<&[Vec<f32>]> = None;
                    if !pending.is_empty() {
                        if let Ok((_, n)) = r.process_partial_into_buffer(Some(&[&pending[..]][..]), &mut out_buf, None) {
                            push(&out_buf[0][..n], &mut samples);
                        }
                    }
                    if let Ok((_, n)) = r.process_partial_into_buffer(rest, &mut out_buf, None) {
                        push(&out_buf[0][..n], &mut samples);
                    }
                }
            }
        }

        if last_emit.elapsed() >= LEVEL_INTERVAL || stopping {
            last_emit = Instant::now();
            let rms = rms_tail(&samples);
            peak_rms = peak_rms.max(rms);
            if !stopping {
                sink(&analyzer.levels(&samples, rms));
            }
        }

        if stopping {
            return Ok(Recording { samples: if keep { samples } else { Vec::new() }, peak_rms });
        }
    }
}

fn downmix<T: Copy>(data: &[T], channels: usize, conv: impl Fn(T) -> f32) -> Vec<f32> {
    let ch = channels.max(1);
    data.chunks_exact(ch)
        .map(|frame| frame.iter().map(|&s| conv(s)).sum::<f32>() / ch as f32)
        .collect()
}

fn rms_tail(samples: &[i16]) -> f32 {
    let tail = &samples[samples.len().saturating_sub(RMS_WINDOW)..];
    if tail.is_empty() {
        return 0.0;
    }
    let sum: f64 = tail.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum();
    (sum / tail.len() as f64).sqrt() as f32
}

/// Log-spaced band edges as FFT bin ranges `[lo, hi)`. Low bands are narrower
/// than one bin at this resolution, so each band is widened to at least one
/// bin and edges never go backwards.
pub fn band_edges(bands: usize, fft_len: usize, rate: usize, f_lo: f32, f_hi: f32) -> Vec<(usize, usize)> {
    let bin_hz = rate as f32 / fft_len as f32;
    let max_bin = fft_len / 2 + 1;
    let mut edges = Vec::with_capacity(bands);
    let mut prev_hi = 1; // skip DC
    for i in 0..bands {
        let f_end = f_lo * (f_hi / f_lo).powf((i + 1) as f32 / bands as f32);
        let lo = prev_hi.min(max_bin - 1);
        let hi = ((f_end / bin_hz).round() as usize).clamp(lo + 1, max_bin);
        edges.push((lo, hi));
        prev_hi = hi;
    }
    edges
}

/// Maps dB into 0..=255 across `[floor, ceil]`.
pub fn db_to_byte(db: f32, floor: f32, ceil: f32) -> u8 {
    (((db - floor) / (ceil - floor)).clamp(0.0, 1.0) * 255.0).round() as u8
}

struct Analyzer {
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    input: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    edges: Vec<(usize, usize)>,
    norm: f32,
}

impl Analyzer {
    fn new() -> Self {
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(FFT_LEN);
        let window: Vec<f32> = (0..FFT_LEN)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_LEN as f32).cos())
            .collect();
        let norm = window.iter().sum::<f32>().powi(2);
        Analyzer {
            input: fft.make_input_vec(),
            spectrum: fft.make_output_vec(),
            scratch: fft.make_scratch_vec(),
            fft,
            window,
            edges: band_edges(BANDS, FFT_LEN, RATE, 90.0, 7600.0),
            norm,
        }
    }

    fn levels(&mut self, samples: &[i16], rms: f32) -> Levels {
        let mut out = [0u8; BANDS + 1];
        out[BANDS] = db_to_byte(20.0 * rms.max(1e-6).log10(), -58.0, -14.0);
        if samples.len() < FFT_LEN {
            return out;
        }
        let tail = &samples[samples.len() - FFT_LEN..];
        for (i, (&s, w)) in tail.iter().zip(&self.window).enumerate() {
            self.input[i] = s as f32 / 32768.0 * w;
        }
        if self.fft.process_with_scratch(&mut self.input, &mut self.spectrum, &mut self.scratch).is_err() {
            return out;
        }
        for (b, &(lo, hi)) in self.edges.iter().enumerate() {
            let power = self.spectrum[lo..hi].iter().map(|c| c.norm_sqr()).sum::<f32>() / (hi - lo) as f32;
            let db = 10.0 * (power * 4.0 / self.norm).max(1e-12).log10();
            // Speech has far less energy up high; tilt so the whole row moves.
            let tilt = b as f32 * 0.7;
            out[b] = db_to_byte(db + tilt, -72.0, -26.0);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn band_edges_are_ordered_and_non_empty() {
        let edges = band_edges(BANDS, FFT_LEN, RATE, 90.0, 7600.0);
        assert_eq!(edges.len(), BANDS);
        let mut prev = 1;
        for &(lo, hi) in &edges {
            assert!(hi > lo, "{lo}..{hi}");
            assert_eq!(lo, prev);
            assert!(hi <= FFT_LEN / 2 + 1);
            prev = hi;
        }
        assert!(edges[BANDS - 1].1 >= 230);
    }

    #[test]
    fn db_mapping_clamps() {
        assert_eq!(db_to_byte(-100.0, -60.0, -20.0), 0);
        assert_eq!(db_to_byte(0.0, -60.0, -20.0), 255);
        assert_eq!(db_to_byte(-40.0, -60.0, -20.0), 128);
    }

    #[test]
    fn analyzer_sees_a_tone_in_the_right_band() {
        let tone: Vec<i16> = (0..FFT_LEN * 2)
            .map(|i| ((2.0 * std::f32::consts::PI * 1000.0 * i as f32 / RATE as f32).sin() * 12000.0) as i16)
            .collect();
        let mut a = Analyzer::new();
        let lv = a.levels(&tone, rms_tail(&tone));
        let loudest = (0..BANDS).max_by_key(|&b| lv[b]).unwrap();
        let (lo, hi) = a.edges[loudest];
        let bin = 1000.0 / (RATE as f32 / FFT_LEN as f32);
        assert!((lo as f32 - 1.0..hi as f32 + 1.0).contains(&bin));
        assert!(lv[BANDS] > 200);
    }
}
