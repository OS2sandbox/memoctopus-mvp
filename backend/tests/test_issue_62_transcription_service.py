"""
Tests for Issue #62: Transcription service validates empty output.

Since the transcription service has heavy NeMo/torch dependencies,
we test the convert_to_wav validation logic in isolation.
"""

import os
import subprocess
import tempfile
import pytest


def convert_to_wav(input_path: str, output_path: str):
    """Extracted from transcription/main.py for testing."""
    result = subprocess.run(
        [
            "ffmpeg", "-i", input_path,
            "-ar", "16000", "-ac", "1", "-f", "wav",
            output_path, "-y",
        ],
        capture_output=True,
    )

    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace")[:500]
        raise ValueError(f"ffmpeg conversion failed: {stderr}")

    file_size = os.path.getsize(output_path)
    if file_size <= 44:
        raise ValueError(
            f"ffmpeg produced an empty audio file ({file_size} bytes). "
            "The input may be silent, corrupted, or in an unsupported format."
        )


def test_convert_to_wav_rejects_empty_output():
    """#62: convert_to_wav should raise ValueError for empty WAV output."""
    from unittest.mock import patch, MagicMock

    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = os.path.join(tmpdir, "output.wav")

        # Create a tiny file (less than WAV header = 44 bytes)
        with open(output_path, "wb") as f:
            f.write(b"\x00" * 10)

        mock_result = MagicMock()
        mock_result.returncode = 0

        with patch("subprocess.run", return_value=mock_result):
            with pytest.raises(ValueError, match="empty audio file"):
                convert_to_wav("/fake/input.wav", output_path)


def test_convert_to_wav_rejects_ffmpeg_failure():
    """#62: convert_to_wav should raise ValueError when ffmpeg fails."""
    from unittest.mock import patch, MagicMock

    mock_result = MagicMock()
    mock_result.returncode = 1
    mock_result.stderr = b"Error: no such file"

    with patch("subprocess.run", return_value=mock_result):
        with pytest.raises(ValueError, match="ffmpeg conversion failed"):
            convert_to_wav("/fake/input.wav", "/fake/output.wav")


def test_convert_to_wav_accepts_valid_file():
    """#62: convert_to_wav should accept a file larger than 44 bytes."""
    from unittest.mock import patch, MagicMock

    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = os.path.join(tmpdir, "output.wav")

        # Create a valid-sized file
        with open(output_path, "wb") as f:
            f.write(b"\x00" * 1000)

        mock_result = MagicMock()
        mock_result.returncode = 0

        with patch("subprocess.run", return_value=mock_result):
            # Should not raise
            convert_to_wav("/fake/input.wav", output_path)
