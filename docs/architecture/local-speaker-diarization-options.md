# Local speaker diarization options

Status: research only; no diarization model is installed or enabled.

## Decision boundary

This delivery remains loopback-only on Windows. Recording audio must stay on the machine, including when diarization runs. Diarization means partitioning audio into anonymous, consistent speaker labels such as `SPEAKER_00` and `SPEAKER_01` with time ranges. It does **not** establish that either label belongs to a named participant. The current `UNATTRIBUTED` posture stays in force until a separately reviewed feature adds an explicit human confirmation/correction flow.

Do not retain voiceprints, enroll participants, or attempt automatic name assignment in the first release. A roster may be used only by a human to confirm or correct an anonymous label for that one meeting. A label or any confidence score must never serve as attendance evidence, authorization input, or the owner of a generated action.

## Options assessed

| Option | Local/offline posture | Windows fit | License / access | Decision |
| --- | --- | --- | --- | --- |
| **`pyannote.audio` + `speaker-diarization-community-1`** | Python worker runs inference locally. The model card documents cloning the gated pipeline once to disk and loading that local path with no Internet connection. It accepts 16 kHz mono audio—the format already produced by this app—and supplies an exclusive diarization output intended to reconcile speaker turns with transcript timestamps. | pyannote is Python/PyTorch based. PyTorch officially supports Windows CPU installs and Windows CUDA installs; an NVIDIA GPU is optional, not required. CPU performance must be measured on the target machine before enabling it. | Toolkit: MIT. Model: CC-BY-4.0. Initial controlled acquisition requires accepting the model conditions, sharing contact information, and a Hugging Face access token. | **Recommended pilot**, subject to license/attribution review and approved controlled model acquisition. |
| **WhisperX** | Provides diarization through the same pyannote Community-1 model and needs the same Hugging Face access. It also substitutes a Python ASR/alignment stack for the app's existing local ONNX Whisper pipeline. | Python environment and optional CUDA workload, plus a second transcription stack. | WhisperX is BSD-2-Clause; diarization still depends on Community-1's CC-BY-4.0 model and gated acquisition. | **Do not use.** It duplicates/replaces working local transcription rather than supplying a focused diarization seam. |
| **NVIDIA NeMo / Sortformer** | NeMo supports offline diarizers and downloaded local checkpoints. Its documented offline Sortformer model emits speaker-indexed segments. | Native Windows `pip` support is not official; an NVIDIA maintainer recommends WSL2. The documented Sortformer model also has an offline, four-speaker limit and GPU-memory-dependent recording length. | The public `diar_sortformer_4spk-v1` model is CC-BY-NC-4.0, unsuitable for a company product without a different reviewed model and runtime. | **Do not use.** Licensing and Windows-operability risk outweigh the benefit. |

Primary sources: [pyannote toolkit](https://github.com/pyannote/pyannote-audio), [Community-1 model card and offline instructions](https://huggingface.co/pyannote/speaker-diarization-community-1), [PyTorch Windows installation](https://docs.pytorch.org/get-started/locally/), [WhisperX diarization documentation](https://github.com/m-bain/whisperX), [NeMo diarization models](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/asr/speaker_diarization/models.html), [NVIDIA Sortformer model card](https://huggingface.co/nvidia/diar_sortformer_4spk-v1), and [NVIDIA's Windows support response](https://github.com/NVIDIA-NeMo/Speech/discussions/6515).

## Recommended pilot: local pyannote worker

Use `pyannote.audio` Community-1 in a version-pinned Python virtual environment started only by the Node server. The Node pipeline writes the already-authorized decrypted WAV to a restricted, per-job temporary directory, invokes the local worker with an input path and an output path, parses strictly bounded JSON containing timestamps and anonymous labels, then removes the temporary audio and worker output in a `finally` path. The worker has no listener, no browser access, no cloud endpoint, and no access to the app's PostgreSQL or Anthropic credentials.

The current operator reports an NVIDIA RTX 3080 (10 GB) and Python 3.10/3.11 are available. That makes a CUDA pilot practical because PyTorch supports Windows CUDA, but it is not a capacity commitment: record the selected Python, PyTorch/CUDA, driver, model revision, processing time, and peak VRAM in the acceptance evidence. CPU remains the safe fallback only if it meets the agreed processing budget.

The initial download is an operator action, not a runtime behavior:

1. Legal/licensing owner reviews CC-BY-4.0 attribution and Hugging Face's gated-model conditions.
2. An operator uses a least-privilege Hugging Face token only on a controlled, connected machine to acquire the exact approved model revision with Git LFS.
3. Record the model revision, file hashes, license notice, and acquisition date in an operator inventory. Copy the complete model directory to the Windows host's protected model directory.
4. Configure the worker only with that local model path. Block its network access at the host firewall and prove one synthetic inference while disconnected. Do not put a Hugging Face token in `.env`, source, logs, browser code, or a service account profile.

The default label display is “Speaker not identified” until an authorized human maps a label for the current meeting and can undo it. Preserve the original label and attribution provenance; mapping must be audited without recording voice embeddings, confidence values, transcript text, or audio in the audit log. Any unconfirmed or conflicting mapping remains unidentified.

## Evaluation and release gates

Do not infer quality from vendor benchmark scores. Before implementation, make a consented test set representative of expected microphones, room acoustics, languages, crosstalk, and meeting sizes. Keep human time-range reference labels separately and measure diarization error rate (DER), missed speech, false alarms, speaker confusion, and runtime/peak memory. Test both GPU and CPU if both may be supported.

The pilot may ship only after all of the following:

- Every test recording has documented consent and an approved retention/deletion plan.
- The model provenance, hashes, license, and offline-disconnect test are recorded.
- A target-machine CPU result completes within the product's acceptable post-processing time, or a supported NVIDIA CUDA configuration is explicitly required and detected at startup.
- Overlapping speech, five-or-more-speaker meetings, non-English audio, noise, and name-like speech have manual review cases. Fail closed to `UNATTRIBUTED` where labels cannot be reconciled safely.
- The UI makes corrections easy, shows the model output as fallible, and never uses a label to grant access, verify attendance, or create a named action owner.
- Security tests prove temporary audio cleanup, no outbound request after model installation, no token in logs/audit/API responses, and tenant-scoped results.

Community-1's own card reports anonymous `speaker_*` outputs and notes its local runtime; NeMo's model card likewise frames diarization output as time ranges plus a speaker index. Those facts support the strict distinction above between diarization and identity, rather than asserting a biometric identity claim. [Community-1 output](https://github.com/pyannote/pyannote-audio#community-1-open-source-speaker-diarization), [Sortformer output](https://huggingface.co/nvidia/diar_sortformer_4spk-v1).

## Work still required after approval

1. Obtain approval for Community-1 acquisition and attribution; no API key for inference is needed after the local model directory has been provisioned.
2. Define an acceptable target-machine processing budget and whether CPU-only support is required.
3. Add a Python worker boundary, strict schema validation, encrypted-audio temporary-file lifecycle, test fixtures, and a human mapping/correction UX. Treat this as a new security-sensitive implementation milestone, not a dependency upgrade.
