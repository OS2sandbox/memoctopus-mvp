import types

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY

WAV = {"file": ("meeting.wav", b"x" * 3_000, "audio/wav")}


def jobs(status: str, reason: str = "") -> float | None:
    return REGISTRY.get_sample_value(
        "memoctopus_diarization_jobs_total", {"status": status, "failure_reason": reason}
    )


def sample(name: str) -> float | None:
    return REGISTRY.get_sample_value(name)


class FakeWaveform:
    shape = (1, 16_000)


class FakeAnnotation:
    """Quacks like a pyannote Annotation: itertracks(yield_label=True)."""

    def __init__(self, tracks):
        self._tracks = tracks

    def itertracks(self, yield_label=False):
        for start, end, speaker in self._tracks:
            yield types.SimpleNamespace(start=start, end=end), None, speaker


def fake_inference(app, monkeypatch, tracks=(((0.0, 1.5, "SPEAKER_00")),)):
    monkeypatch.setattr(app, "_load_audio", lambda data: (FakeWaveform(), 16_000))
    monkeypatch.setattr(app, "get_pipeline", lambda: (lambda inputs: FakeAnnotation(list(tracks))))


# ── series exist before the first job ─────────────────────────────────────────

def test_job_series_exist_at_zero_before_any_job(load_app):
    load_app()
    # A labelled counter has no samples until its first .inc(), which would make
    # rate(...{status="failure"}) return nothing until the first failure happens.
    assert jobs("success") == 0.0
    assert jobs("failure", "invalid_audio") == 0.0
    assert jobs("failure", "internal_error") == 0.0


# ── job outcomes ──────────────────────────────────────────────────────────────

def test_successful_job_counts_success_and_observes_both_histograms(load_app, monkeypatch):
    app = load_app()
    fake_inference(app, monkeypatch, tracks=[(2.0, 3.0, "SPEAKER_01"), (0.0, 1.5, "SPEAKER_00")])
    client = TestClient(app.app)

    res = client.post("/diarize", files=WAV)

    assert res.status_code == 200
    assert res.json()["turns"] == [
        {"speaker": "SPEAKER_00", "start": 0.0, "end": 1.5},
        {"speaker": "SPEAKER_01", "start": 2.0, "end": 3.0},
    ]
    assert jobs("success") == 1.0
    assert sample("memoctopus_diarization_duration_seconds_count") == 1.0
    assert sample("memoctopus_diarization_queue_wait_seconds_count") == 1.0


def test_undecodable_audio_is_counted_as_invalid_audio(load_app, monkeypatch):
    app = load_app()

    def undecodable(data):
        raise HTTPException(status_code=400, detail="Undecodable audio")

    monkeypatch.setattr(app, "_load_audio", undecodable)
    client = TestClient(app.app)

    res = client.post("/diarize", files=WAV)

    assert res.status_code == 400
    assert jobs("failure", "invalid_audio") == 1.0
    assert jobs("failure", "internal_error") == 0.0
    # Failures are not observed: a decode that fails in 50 ms would drag percentiles down.
    assert sample("memoctopus_diarization_duration_seconds_count") == 0.0


def test_missing_ffmpeg_is_our_fault_not_the_callers(load_app, monkeypatch):
    app = load_app()

    def no_ffmpeg(data):
        raise HTTPException(status_code=415, detail="ffmpeg not installed")

    monkeypatch.setattr(app, "_load_audio", no_ffmpeg)

    res = TestClient(app.app).post("/diarize", files=WAV)

    assert res.status_code == 415
    assert jobs("failure", "internal_error") == 1.0
    assert jobs("failure", "invalid_audio") == 0.0


def test_unexpected_error_is_counted_as_internal_error(load_app, monkeypatch):
    app = load_app()
    monkeypatch.setattr(app, "_load_audio", lambda data: (FakeWaveform(), 16_000))

    def broken_pipeline():
        raise RuntimeError("CUDA out of memory")

    monkeypatch.setattr(app, "get_pipeline", broken_pipeline)

    res = TestClient(app.app, raise_server_exceptions=False).post("/diarize", files=WAV)

    assert res.status_code == 500
    assert jobs("failure", "internal_error") == 1.0


def test_missing_file_field_is_counted_as_invalid_audio(load_app):
    app = load_app()

    res = TestClient(app.app).post("/diarize", files={"other": ("x.wav", b"x" * 3_000)})

    assert res.status_code == 422
    assert jobs("failure", "invalid_audio") == 1.0


def test_tiny_upload_counts_success_without_observing_duration(load_app):
    app = load_app()

    res = TestClient(app.app).post("/diarize", files={"file": ("t.wav", b"x" * 100)})

    assert res.json() == {"turns": []}
    assert jobs("success") == 1.0  # documented: too small to contain speech, not a failure
    assert sample("memoctopus_diarization_duration_seconds_count") == 0.0


# ── /metrics access ───────────────────────────────────────────────────────────

def test_metrics_is_open_by_default_even_when_a_key_is_set(load_app):
    client = TestClient(load_app(DIARIZATION_API_KEY="secret").app)

    assert client.get("/metrics").status_code == 200


def test_metrics_requires_the_bearer_token_when_the_flag_is_set(load_app):
    client = TestClient(
        load_app(DIARIZATION_API_KEY="secret", DIARIZATION_METRICS_REQUIRE_AUTH="true").app
    )

    assert client.get("/metrics").status_code == 401
    assert client.get("/metrics", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/metrics", headers={"Authorization": "Bearer secret"}).status_code == 200
    assert client.get("/health").status_code == 200  # health stays open for probes


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes"])
def test_flag_accepts_the_documented_spellings(load_app, value):
    client = TestClient(
        load_app(DIARIZATION_API_KEY="secret", DIARIZATION_METRICS_REQUIRE_AUTH=value).app
    )

    assert client.get("/metrics").status_code == 401


def test_warns_at_startup_when_the_flag_is_set_but_there_is_no_key(load_app, capsys):
    app = load_app(DIARIZATION_METRICS_REQUIRE_AUTH="true")

    assert "DIARIZATION_API_KEY" in capsys.readouterr().out
    # ...and the flag really does nothing without a key, which is what the warning is for.
    assert TestClient(app.app).get("/metrics").status_code == 200


def test_no_warning_when_the_flag_is_set_with_a_key(load_app, capsys):
    load_app(DIARIZATION_API_KEY="secret", DIARIZATION_METRICS_REQUIRE_AUTH="true")

    assert "WARNING" not in capsys.readouterr().out
