# Voice and drawing

Dictation: speak, and the words land in the composer. Everything happens on this
computer — the audio never reaches a network Emma does not control, and that is
enforced, not promised.

## Off until you turn it on

**Settings → Voice**. Until `transcriptionEnabled` is on there is no microphone
access, no helper, and no orb. Turning it on lets Emma request the platform's
microphone permission where applicable.

## Recording

The renderer records, because `MediaRecorder` lives there
([`desktop/src/voice.ts`](../desktop/src/voice.ts)); nothing else about voice
does.

| | |
|---|---|
| Captured as | WebM/Opus, echo cancellation and noise suppression on |
| Sent as | 16 kHz mono 16-bit WAV — decoded and rewritten before it leaves the renderer, because llama.cpp sniffs containers by magic bytes and takes RIFF/WAVE, MP3 or fLaC only |
| Ceiling | `MAX_UTTERANCE_BYTES` — 12 MiB |
| After | Every track is stopped, so the platform's recording indicator goes out |

`validateUtterance` re-checks the buffer and the MIME type in main before
anything touches it.

## Two engines

| | Built-in recognizer | Local server |
|---|---|---|
| Engine | macOS Speech.framework through `emma-transcribe`; Windows SAPI through `emma-transcribe.exe` | [llama.cpp](https://github.com/ggml-org/llama.cpp) at `http://127.0.0.1:8080/v1/audio/transcriptions` |
| Model | The operating system's on-device speech model for the configured locale or language | `ggml-org/Qwen3-ASR-0.6B-GGUF` |
| Install | Nothing beyond the platform speech setup | Install `llama.cpp`, then run `llama-server -hf ggml-org/Qwen3-ASR-0.6B-GGUF --port 8080` |
| Needs | macOS Speech Recognition and the **packaged** Emma.app; Windows speech recognition is provided by SAPI | Nothing from the operating system |

`emma-transcribe` ([`desktop/native/transcribe.m`](../desktop/native/transcribe.m)
on macOS and [`desktop/native/transcribe_win.cpp`](../desktop/native/transcribe_win.cpp)
on Windows, built with the platform toolchain) is a two-line contract:
`--check [locale]` prints `ready` or the reason it cannot, and `<wav> [locale]`
prints the transcript. The macOS helper pins `requiresOnDeviceRecognition = YES`,
so a Mac with no downloaded model for the locale fails loudly instead of uploading
to Apple, and it asks for `SFSpeechRecognitionTaskHintDictation` with punctuation
on. The Windows helper uses the installed SAPI dictation recognizer.

Under `npm run dev` macOS aborts the helper — TCC reads the *responsible*
process's `NSSpeechRecognitionUsageDescription`, which only the packaged app
carries. The error says so. Windows has no equivalent app-bundle TCC check; its
SAPI helper still needs a supported Windows speech recognition language.

## The cleanup pass

Optional second stage: a 0.6B text model rewrites the raw transcript as written
English — fillers dropped, self-corrections resolved, numbers and punctuation
rendered. Not a speech model; it only ever reads what stage one heard.

| | |
|---|---|
| Model | `superwhisper/s1-mini-GGUF:Q4_K_M` |
| Endpoint | `http://127.0.0.1:8081/v1/chat/completions` |
| Sent with | `temperature 0`, `top_p 1`, `max_tokens 512`, `enable_thinking: false` — every request, because the GGUF's inherited metadata says otherwise |
| Install | `llama-server -hf superwhisper/s1-mini-GGUF:Q4_K_M --jinja --chat-template-kwargs '{"enable_thinking":false}' --temp 0 --port 8081` |

It never throws. A cleanup that fails, times out, or answers with something much
longer than what was said hands back the raw transcript — a rough transcript
beats an error where the words should be.

## Local only, checked twice

`localEndpoint` ([`desktop/shared/settings.ts`](../desktop/shared/settings.ts))
accepts `http`/`https` on `localhost`, `127.0.0.1` or `[::1]` and nothing else.
It runs at both boundaries:

| When | What happens |
|---|---|
| Saving settings | `validateSettings` throws *"Transcription endpoint must be local"* and *"The transcript cleanup endpoint must be local"* — the settings never store a remote address |
| Before every use | `transcribe` re-checks and throws *"The speech-to-text endpoint must be a local address."*; `polish` silently returns the raw text |

So a settings file edited by hand cannot redirect the audio. Main is what
enforces it, because a sandboxed `file://` renderer cannot reach localhost or
spawn a helper anyway.

## Audio on disk

Both built-in helpers touch disk because they read a WAV path: `mkdtemp` under
the system temp directory, `utterance.wav` at mode `0600`, read once, and the
whole directory removed in a `finally` — deleted whether or not the recognizer
succeeded. The server engine posts the buffer straight from memory. Nothing
keeps the audio, and neither the recording nor the raw transcript is written
into a thread.

| Timeout | Value |
|---|---|
| Liveness probe | 1.5 s |
| Transcription | 120 s |
| Cleanup | 20 s |
| First-run authorization | 60 s |

## Hold to talk

Hold the space bar in the island — it starts listening after
`voiceHoldMs` (200/300/400/600/800 ms, default **400**) and stops when you let
go. Armed only when the composer is empty and nothing is running, so space stays
space when you are typing. A shortcut can be bound to **Quick Ask with voice**
in **Settings → Shortcuts** to open the island already listening.

## Drawing

The ✎ orb hides the island and puts a transparent window over the whole display.
Draw on it with a 5px `#ffe84f` stroke; **Escape** cancels.

`SETTLE_MS` (700 ms) after the last stroke, Emma captures the display behind the
canvas, composites the drawing over it, and encodes it as JPEG:

| Step | Detail |
|---|---|
| Capture | `desktopCapturer`, capped at 2560×1600, JPEG 82 |
| Composite | The frame, then the canvas, at the frame's own size |
| Compress | Widths min(w, 1440)/1200/960/720 × qualities 68/54/42/32, first fit wins |
| Ceiling | `MAX_SCREEN_CONTEXT_CHARS` — 96 KiB of data URL |

The result is held in main's `ScreenContextStore` — one attachment, claimed for
one turn and dropped once it lands. **The frame stays in Emma's process**: what
travels with the turn is a line of text naming the app that was in front. The
`vision` tool is the only deliberate way an image reaches a model.

The ▣ orb is the same capture without the pen.

## See also

- [notch.md](notch.md) — the island, the orbs and the shortcuts
- [privacy.md](privacy.md) — what leaves this computer
- [computer-use.md](computer-use.md) — approved app controls without screen capture
- [models.md](models.md) — the vision endpoint, the one exception
