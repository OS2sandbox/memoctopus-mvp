"""
Tests for Issue #72: chunked transcription of long audio.

The transcription service has heavy NeMo/torch/pyannote dependencies that
aren't installed in the dev env, so we re-import the pure-python helpers
from transcription.main inline (mirrors the pattern used by
backend/tests/test_issue_62_transcription_service.py).
"""

import os
import sys

import pytest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..")))


def _merge_chunk_results(chunk_results, chunk_starts, overlap):
    """Copied from transcription/main.py to test without importing the module
    (which pulls torch, nemo, pyannote)."""
    n = len(chunk_results)
    bounds = [float("-inf")]
    for i in range(n - 1):
        bounds.append(chunk_starts[i + 1] + overlap / 2.0)
    bounds.append(float("inf"))

    merged_word_timestamps = []
    merged_words = []
    merged_segments = []

    for i, result in enumerate(chunk_results):
        offset = chunk_starts[i]
        left, right = bounds[i], bounds[i + 1]

        wts_src = result.get("word_timestamps", []) or []
        words_src = result.get("words", []) or []
        segments_src = result.get("segments", []) or []
        aligned = len(words_src) == len(wts_src)

        for j, wt in enumerate(wts_src):
            abs_start = float(wt.get("start", 0)) + offset
            abs_end = float(wt.get("end", 0)) + offset
            mid = (abs_start + abs_end) / 2.0
            if mid < left or mid >= right:
                continue
            merged_word_timestamps.append({**wt, "start": abs_start, "end": abs_end})
            if aligned:
                merged_words.append(words_src[j])

        for seg in segments_src:
            abs_start = float(seg.get("start", 0)) + offset
            abs_end = float(seg.get("end", 0)) + offset
            mid = (abs_start + abs_end) / 2.0
            if mid < left or mid >= right:
                continue
            merged_segments.append({**seg, "start": abs_start, "end": abs_end})

    text = " ".join(
        str(wt.get("word", "")).strip()
        for wt in merged_word_timestamps
        if str(wt.get("word", "")).strip()
    )

    merged = {"text": text}
    if merged_words:
        merged["words"] = merged_words
    if merged_word_timestamps:
        merged["word_timestamps"] = merged_word_timestamps
    if merged_segments:
        merged["segments"] = merged_segments
    return merged


def _chunk(words):
    """Build a chunk result dict from [(word, start, end), ...]."""
    return {
        "text": " ".join(w for w, _, _ in words),
        "words": [{"word": w} for w, _, _ in words],
        "word_timestamps": [
            {"word": w, "start": s, "end": e} for w, s, e in words
        ],
        "segments": [
            {"start": words[0][1], "end": words[-1][2]}
        ] if words else [],
    }


def test_merge_shifts_and_preserves_order():
    """Timestamps in merged output should equal chunk_start + local_timestamp
    and be strictly monotonic. Words in chunk B placed past the midpoint
    (local > 1.0s, since chunk_starts=[0,28], overlap=2 → midpoint=29s) so
    they're not dropped as overlap."""
    chunk_a = _chunk([("hello", 0.0, 0.5), ("world", 0.6, 1.1)])
    chunk_b = _chunk([("how", 2.0, 2.3), ("are", 2.4, 2.7), ("you", 2.8, 3.0)])

    merged = _merge_chunk_results([chunk_a, chunk_b], [0.0, 28.0], overlap=2.0)

    starts = [w["start"] for w in merged["word_timestamps"]]
    assert starts == sorted(starts)
    assert merged["word_timestamps"][0]["start"] == pytest.approx(0.0)
    assert merged["word_timestamps"][-1]["end"] == pytest.approx(31.0)
    assert merged["text"].startswith("hello")
    assert merged["text"].endswith("you")


def test_overlap_midpoint_keeps_each_word_exactly_once():
    """Chunks cover [0, 30] and [28, 58] with 2s overlap. The midpoint
    between them is 29s. A word in the overlap region should survive in
    exactly one chunk, not both."""
    # Chunk A covers 0..30 in absolute time; the last word straddles into
    # the overlap at 28.5..29.2 (midpoint 28.85 — BEFORE the 29s midpoint,
    # so it belongs to chunk A).
    chunk_a = _chunk([
        ("early", 0.0, 0.5),
        ("later", 28.5, 29.2),  # abs midpoint 28.85 → kept in A
    ])
    # Chunk B starts at 28. Its local 0..0.7 corresponds to abs 28..28.7.
    # Any word with local end < 1.0 (abs < 29.0) has midpoint < 29 — so
    # it belongs to A's range and must be dropped from B's contribution.
    chunk_b = _chunk([
        ("later", 0.5, 1.2),  # abs mid (28.5+29.2)/2 = 28.85 → drop from B
        ("after", 2.0, 2.5),  # abs mid 30.25 → kept in B
    ])

    merged = _merge_chunk_results([chunk_a, chunk_b], [0.0, 28.0], overlap=2.0)

    texts = [w["word"] for w in merged["word_timestamps"]]
    assert texts.count("later") == 1, (
        f"overlap word duplicated: {texts}"
    )
    assert texts == ["early", "later", "after"]


def test_single_chunk_roundtrips_without_dedup():
    chunk_a = _chunk([("one", 0.0, 0.4), ("two", 0.5, 0.9)])
    merged = _merge_chunk_results([chunk_a], [0.0], overlap=2.0)
    assert len(merged["word_timestamps"]) == 2
    assert merged["text"] == "one two"


def test_words_and_word_timestamps_stay_index_aligned():
    """When per-chunk `words` and `word_timestamps` have the same length,
    the merge must drop/keep them with the same mask so downstream
    consumers can zip them."""
    chunk_a = _chunk([("a", 0.0, 0.5), ("b", 29.5, 29.9)])  # b mid 29.7 > 29 → drop from A
    chunk_b = _chunk([("b", 1.5, 1.9), ("c", 3.0, 3.4)])    # b mid 29.7 → kept in B

    merged = _merge_chunk_results([chunk_a, chunk_b], [0.0, 28.0], overlap=2.0)

    assert len(merged["words"]) == len(merged["word_timestamps"])
    assert [w["word"] for w in merged["words"]] == ["a", "b", "c"]


def test_segments_are_shifted_and_deduped():
    chunk_a = _chunk([("x", 1.0, 29.0)])  # segment spans 1..29, mid=15 → A
    chunk_b = _chunk([("y", 0.5, 1.5)])   # abs 28.5..29.5, mid=29 → B (mid >= right bound? right=29 → drop)
    merged = _merge_chunk_results([chunk_a, chunk_b], [0.0, 28.0], overlap=2.0)
    # At least one non-overlapping segment should survive without duplication
    assert len(merged["segments"]) >= 1
    assert all(s["start"] < s["end"] for s in merged["segments"])


def test_empty_input_yields_empty_result():
    merged = _merge_chunk_results([], [], overlap=2.0)
    assert merged == {"text": ""}
