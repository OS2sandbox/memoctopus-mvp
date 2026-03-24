"""
Tests for Issue #63: NeMo partial unfreeze error.

Since the transcription service has heavy NeMo/torch dependencies,
we test the freeze logic by replicating the do_transcribe function
and verifying it calls encoder.freeze().
"""

from unittest.mock import MagicMock


def do_transcribe_with_freeze(model, audio_path: str, timestamps: bool = False) -> dict:
    """Replicates the fix from transcription/main.py for testing."""
    # This is the fix: freeze encoder before transcription
    if hasattr(model, "encoder") and hasattr(model.encoder, "freeze"):
        try:
            model.encoder.freeze()
        except Exception:
            pass

    output = model.transcribe(
        [audio_path], return_hypotheses=timestamps, timestamps=timestamps
    )
    hyp = output[0]

    if not timestamps:
        text = hyp.text if hasattr(hyp, "text") else str(hyp)
        return {"text": text}

    if isinstance(hyp, list):
        hyp = hyp[0]

    return {"text": hyp.text}


def test_do_transcribe_freezes_encoder():
    """#63: do_transcribe should call encoder.freeze() before transcription."""
    mock_encoder = MagicMock()
    mock_encoder.freeze = MagicMock()

    mock_model = MagicMock()
    mock_model.encoder = mock_encoder

    mock_hyp = MagicMock()
    mock_hyp.text = "Test transcription"
    mock_model.transcribe.return_value = [mock_hyp]

    result = do_transcribe_with_freeze(mock_model, "/fake/audio.wav", timestamps=False)

    # Verify encoder was frozen before transcription
    mock_encoder.freeze.assert_called_once()
    mock_model.transcribe.assert_called_once()
    assert result["text"] == "Test transcription"


def test_do_transcribe_handles_missing_encoder():
    """#63: do_transcribe should not crash if model has no encoder."""
    mock_model = MagicMock(spec=["transcribe"])

    mock_hyp = MagicMock()
    mock_hyp.text = "Test transcription"
    mock_model.transcribe.return_value = [mock_hyp]

    # Should not raise — encoder is missing but that's OK
    result = do_transcribe_with_freeze(mock_model, "/fake/audio.wav", timestamps=False)
    assert result["text"] == "Test transcription"


def test_do_transcribe_handles_freeze_exception():
    """#63: do_transcribe should not crash if encoder.freeze() raises."""
    mock_encoder = MagicMock()
    mock_encoder.freeze.side_effect = RuntimeError("Already frozen")

    mock_model = MagicMock()
    mock_model.encoder = mock_encoder

    mock_hyp = MagicMock()
    mock_hyp.text = "Test transcription"
    mock_model.transcribe.return_value = [mock_hyp]

    # Should not raise — freeze failure is caught
    result = do_transcribe_with_freeze(mock_model, "/fake/audio.wav", timestamps=False)
    assert result["text"] == "Test transcription"
    mock_encoder.freeze.assert_called_once()
