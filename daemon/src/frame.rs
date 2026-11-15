//! NDJSON framing with a hard 32 MiB cap on a single frame.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// Maximum accepted frame size (32 MiB). Anything larger is a protocol error
/// and closes the connection.
pub const MAX_FRAME: usize = 32 * 1024 * 1024;

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    TooLarge(usize),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Io(err) => write!(f, "i/o error while reading frame: {err}"),
            FrameError::TooLarge(size) => write!(
                f,
                "frame exceeds the {MAX_FRAME} byte limit (read at least {size} bytes)"
            ),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<io::Error> for FrameError {
    fn from(value: io::Error) -> Self {
        FrameError::Io(value)
    }
}

/// Read one newline-delimited frame. Returns `None` on clean EOF.
///
/// Reads through `fill_buf` so a client that never sends a newline cannot make
/// the daemon buffer without bound: the limit is enforced on every chunk.
pub async fn read_frame<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<Vec<u8>>, FrameError> {
    read_frame_with_limit(reader, MAX_FRAME).await
}

pub async fn read_frame_with_limit<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> Result<Option<Vec<u8>>, FrameError> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    loop {
        // Scope the borrow so the buffer can be extended before consuming.
        let (consume_len, done, empty) = {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                (0, false, true)
            } else {
                let (copy_len, consume_len, done) =
                    match available.iter().position(|byte| *byte == b'\n') {
                        Some(pos) => (pos, pos + 1, true),
                        None => (available.len(), available.len(), false),
                    };
                if buf.len() + copy_len > limit {
                    return Err(FrameError::TooLarge(buf.len() + copy_len));
                }
                buf.extend_from_slice(&available[..copy_len]);
                (consume_len, done, false)
            }
        };

        if empty {
            return if buf.is_empty() {
                Ok(None)
            } else {
                Ok(Some(buf))
            };
        }

        reader.consume(consume_len);

        if done {
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(Some(buf));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    async fn frames(input: &[u8], limit: usize) -> Vec<Result<Option<Vec<u8>>, String>> {
        let mut reader = BufReader::new(input);
        let mut out = Vec::new();
        loop {
            match read_frame_with_limit(&mut reader, limit).await {
                Ok(Some(frame)) => out.push(Ok(Some(frame))),
                Ok(None) => {
                    out.push(Ok(None));
                    break;
                }
                Err(err) => {
                    out.push(Err(err.to_string()));
                    break;
                }
            }
        }
        out
    }

    #[tokio::test]
    async fn splits_on_newlines_and_keeps_embedded_braces() {
        let out = frames(b"{\"a\":1}\n{\"b\":2}\n", 1024).await;
        assert_eq!(out.len(), 3);
        assert_eq!(
            out[0].as_ref().expect("ok").as_deref(),
            Some(&b"{\"a\":1}"[..])
        );
        assert_eq!(
            out[1].as_ref().expect("ok").as_deref(),
            Some(&b"{\"b\":2}"[..])
        );
        assert!(out[2].as_ref().expect("ok").is_none());
    }

    #[tokio::test]
    async fn strips_carriage_returns() {
        let out = frames(b"{\"a\":1}\r\n", 1024).await;
        assert_eq!(
            out[0].as_ref().expect("ok").as_deref(),
            Some(&b"{\"a\":1}"[..])
        );
    }

    #[tokio::test]
    async fn rejects_oversized_frames() {
        let out = frames(b"0123456789\n", 8).await;
        assert!(out[0].as_ref().is_err(), "expected a size error");
        assert!(out[0]
            .as_ref()
            .expect_err("err")
            .contains("read at least 10 bytes"))
    }

    #[tokio::test]
    async fn unbounded_input_without_newline_is_capped() {
        let chunk = vec![b'x'; 64];
        let out = frames(&chunk, 16).await;
        assert!(out[0].as_ref().is_err());
    }

    #[tokio::test]
    async fn eof_with_partial_frame_returns_it() {
        let out = frames(b"{\"a\":1}", 1024).await;
        assert_eq!(
            out[0].as_ref().expect("ok").as_deref(),
            Some(&b"{\"a\":1}"[..])
        );
    }
}
