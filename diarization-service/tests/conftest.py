"""Harness for testing app.py without torch, pyannote or a GPU.

The metrics and auth logic live at module level in app.py, so the tests import the real
module. torch and pyannote are replaced by tiny stubs (they are only needed for inference,
which the tests fake), and every test gets a fresh import so environment variables such
as DIARIZATION_METRICS_REQUIRE_AUTH take effect.

Needs Python 3.10+ (app.py uses `X | None` annotations at runtime):

    pip install fastapi python-multipart prometheus-fastapi-instrumentator numpy httpx pytest
    pytest diarization-service/tests
"""

import importlib
import sys
import types
from pathlib import Path

import pytest
from prometheus_client import REGISTRY

SERVICE_DIR = str(Path(__file__).resolve().parent.parent)


def _install_stubs() -> None:
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)
    torch.Tensor = object
    torch.device = lambda name: name
    sys.modules["torch"] = torch

    class Pipeline:  # only referenced in annotations; get_pipeline is patched in tests
        pass

    audio = types.ModuleType("pyannote.audio")
    audio.Pipeline = Pipeline
    pyannote = types.ModuleType("pyannote")
    pyannote.audio = audio
    sys.modules["pyannote"] = pyannote
    sys.modules["pyannote.audio"] = audio


def _reset_metrics() -> None:
    # app.py registers its metrics (and the instrumentator's) in the default registry at
    # import time, so a second import would fail with "Duplicated timeseries".
    for collector in list(REGISTRY._collector_to_names):
        REGISTRY.unregister(collector)


@pytest.fixture
def load_app(monkeypatch):
    """Import app.py fresh with the given environment; returns the module."""
    _install_stubs()
    if SERVICE_DIR not in sys.path:
        monkeypatch.syspath_prepend(SERVICE_DIR)

    def _load(**env: str):
        for key in ("DIARIZATION_API_KEY", "DIARIZATION_METRICS_REQUIRE_AUTH"):
            monkeypatch.delenv(key, raising=False)
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        _reset_metrics()
        sys.modules.pop("app", None)
        return importlib.import_module("app")

    yield _load
    _reset_metrics()
    sys.modules.pop("app", None)
