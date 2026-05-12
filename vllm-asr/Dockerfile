# Thin overlay on vllm/vllm-openai:v0.19.0 that adds librosa.
#
# Pinned to v0.19.0 because v0.19.1 regresses CohereAsrForConditionalGeneration
# decoding for syvai/hviske-v5.1 — the model loads and returns 200 but the
# decoder emits an empty token stream. v0.19.0 (which the production endpoint
# at 217.171.200.22:43777 runs) transcribes the same audio correctly.
#
# vLLM ships a native processor for CohereAsrForConditionalGeneration
# (vllm/transformers_utils/processors/cohere_asr.py) which imports librosa
# at module load, but the upstream image doesn't include librosa as a dep —
# booting hviske-v5.1 otherwise fails with `ModuleNotFoundError: librosa`.

FROM vllm/vllm-openai:v0.19.0

RUN pip install --no-cache-dir librosa
