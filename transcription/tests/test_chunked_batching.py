"""
Tests for the chunked-batching fix on top of #72 (felipesdacosta's repro
on PR #74: 5-min audio crashed the transcription container with
"CUDA error: an illegal memory access was encountered").

The previous loop called `model.transcribe([single_path])` once per chunk,
which churned NeMo's encoder freeze/unfreeze lifecycle and accumulated
CUDA stream-ordering issues across the N consecutive calls. The fix runs
all chunks through a single `model.transcribe(all_paths, batch_size=N)`
call so the lifecycle hooks fire once.

These tests pin the new batched-call semantics. They mirror the
inline-recreation pattern used in test_issue_72_chunking.py because the
transcription service has heavy NeMo/torch/pyannote deps that aren't
installed in the dev env.
"""

import os
import sys
from unittest.mock import MagicMock

import pytest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..")))


class FakeHypothesis:
    """Stand-in for nemo.collections.asr's Hypothesis dataclass."""

    def __init__(self, text, words=None, word_confidence=None, timestamp=None):
        self.text = text
        self.words = words or []
        self.word_confidence = word_confidence or []
        self.timestamp = timestamp


def _parse_hypothesis(hyp, timestamps):
    """Copied verbatim from transcription/main.py."""
    if not timestamps:
        text = hyp.text if hasattr(hyp, "text") else str(hyp)
        return {"text": text}

    if isinstance(hyp, list):
        hyp = hyp[0]

    result = {"text": hyp.text}

    if hasattr(hyp, "words") and hyp.words:
        words = []
        confidences_raw = getattr(hyp, "word_confidence", None)
        confidences = (
            list(confidences_raw)
            if confidences_raw is not None and len(confidences_raw) > 0
            else []
        )
        for i, word in enumerate(hyp.words):
            entry = {"word": word}
            if i < len(confidences):
                entry["confidence"] = round(confidences[i], 3)
            words.append(entry)
        result["words"] = words

    ts = getattr(hyp, "timestamp", None) or getattr(hyp, "timestep", None)
    if ts and isinstance(ts, dict):
        if "segment" in ts:
            result["segments"] = ts["segment"]
        if "word" in ts:
            result["word_timestamps"] = ts["word"]

    return result


def _transcribe_many(model, audio_paths, timestamps, batch_size):
    """Copied from transcription/main.py with `model` parameterized so the
    test can inject a mock without importing the heavy module."""
    outputs = model.transcribe(
        audio_paths,
        batch_size=batch_size,
        return_hypotheses=timestamps,
        timestamps=timestamps,
    )
    if (
        len(outputs) == 2
        and isinstance(outputs[0], list)
        and isinstance(outputs[1], list)
        and len(outputs[0]) == len(audio_paths)
    ):
        outputs = outputs[0]
    return [_parse_hypothesis(h, timestamps) for h in outputs]


def test_chunked_path_invokes_transcribe_exactly_once():
    """The core fix: 11 chunks (5-min audio at 30s/chunk, 2s overlap) must
    flow through a SINGLE model.transcribe() call, not 11. Repeated
    single-item calls were the root cause of the CUDA illegal-memory-access
    crash reported by felipesdacosta."""
    model = MagicMock()
    chunk_paths = [f"/tmp/chunk_{i:05d}.wav" for i in range(11)]
    fake_hyps = [FakeHypothesis(text=f"chunk text {i}") for i in range(11)]
    model.transcribe.return_value = fake_hyps

    results = _transcribe_many(model, chunk_paths, timestamps=True, batch_size=4)

    assert model.transcribe.call_count == 1, (
        f"expected ONE batched call, got {model.transcribe.call_count} — "
        "this would re-introduce the bug felipesdacosta reported"
    )
    args, kwargs = model.transcribe.call_args
    assert args[0] == chunk_paths, "all chunks must be in the single call"
    assert kwargs["batch_size"] == 4
    assert kwargs["timestamps"] is True
    assert kwargs["return_hypotheses"] is True
    assert len(results) == 11


def test_transcribe_many_returns_one_dict_per_path():
    model = MagicMock()
    fake_hyps = [
        FakeHypothesis(text="hello world", words=["hello", "world"]),
        FakeHypothesis(text="foo bar", words=["foo", "bar"]),
    ]
    model.transcribe.return_value = fake_hyps

    results = _transcribe_many(
        model, ["/tmp/a.wav", "/tmp/b.wav"], timestamps=True, batch_size=2
    )

    assert len(results) == 2
    assert results[0]["text"] == "hello world"
    assert results[1]["text"] == "foo bar"
    assert [w["word"] for w in results[0]["words"]] == ["hello", "world"]


def test_unwraps_nested_best_and_beams_output_shape():
    """NeMo with return_hypotheses=True can return [best_list, beams_list].
    The unwrapper must collapse to best_list, not treat the pair as two
    chunks."""
    model = MagicMock()
    best = [FakeHypothesis(text="a"), FakeHypothesis(text="b")]
    beams = [
        [FakeHypothesis(text="a"), FakeHypothesis(text="a'")],
        [FakeHypothesis(text="b"), FakeHypothesis(text="b'")],
    ]
    model.transcribe.return_value = [best, beams]

    results = _transcribe_many(
        model, ["/tmp/a.wav", "/tmp/b.wav"], timestamps=True, batch_size=2
    )

    assert [r["text"] for r in results] == ["a", "b"]


def test_flat_output_passes_through_unchanged():
    """When NeMo returns a flat list (length matches paths), don't try to
    unwrap — the [best, beams] heuristic must not misfire on the common
    case."""
    model = MagicMock()
    flat = [FakeHypothesis(text="x"), FakeHypothesis(text="y")]
    model.transcribe.return_value = flat

    results = _transcribe_many(
        model, ["/tmp/a.wav", "/tmp/b.wav"], timestamps=True, batch_size=2
    )

    assert [r["text"] for r in results] == ["x", "y"]


def test_no_timestamps_path_returns_text_only():
    model = MagicMock()
    # Without return_hypotheses NeMo returns strings, not Hypothesis objects.
    model.transcribe.return_value = ["just text one", "just text two"]

    results = _transcribe_many(
        model, ["/tmp/a.wav", "/tmp/b.wav"], timestamps=False, batch_size=2
    )

    assert results == [{"text": "just text one"}, {"text": "just text two"}]
    args, kwargs = model.transcribe.call_args
    assert kwargs["timestamps"] is False
    assert kwargs["return_hypotheses"] is False
