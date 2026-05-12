# Thin overlay on vllm/vllm-openai:v0.19.1 that adds librosa.
#
# vLLM 0.19.1 ships a native processor for CohereAsrForConditionalGeneration
# (vllm/transformers_utils/processors/cohere_asr.py) which imports librosa
# at module load, but the upstream docker image doesn't include librosa as
# a dep — booting hviske-v5.1 fails with `ModuleNotFoundError: librosa`.
# Install it here so the image is plug-and-play.

FROM vllm/vllm-openai:v0.19.1

RUN pip install --no-cache-dir librosa
