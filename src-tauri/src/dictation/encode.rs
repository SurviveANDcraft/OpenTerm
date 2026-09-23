//! FLAC encoding (pure Rust). Lossless, about half the size of WAV, and one of
//! the three formats MAI-Transcribe accepts.

use flacenc::bitsink::ByteSink;
use flacenc::component::BitRepr;
use flacenc::error::Verify;
use flacenc::source::MemSource;

use super::audio::RATE;

pub fn flac(samples: &[i16]) -> Result<Vec<u8>, String> {
    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|e| format!("{e:?}"))?;
    let wide: Vec<i32> = samples.iter().map(|&s| s as i32).collect();
    let source = MemSource::from_samples(&wide, 1, 16, RATE);
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| format!("{e:?}"))?;
    let mut sink = ByteSink::new();
    stream.write(&mut sink).map_err(|e| format!("{e:?}"))?;
    Ok(sink.as_slice().to_vec())
}

#[cfg(test)]
mod tests {
    #[test]
    fn encodes_a_valid_flac_stream() {
        let tone: Vec<i16> = (0..16_000)
            .map(|i| ((i as f32 * 0.07).sin() * 9000.0) as i16)
            .collect();
        let bytes = super::flac(&tone).unwrap();
        assert_eq!(&bytes[..4], b"fLaC");
        assert!(bytes.len() < tone.len() * 2);
    }
}
