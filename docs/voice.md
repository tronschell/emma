# Voice and drawing

Dictation, and the pen that lets you scribble on your own screen and hand the
result to Emma. Both are off-by-default, both stay on this Mac, and both are
reached from the Quick Ask island.

The pipeline is [main/voice.ts](../desktop/main/voice.ts) (the engines),
[shared/voice.ts](../desktop/shared/voice.ts) (the vocabulary and the
validators), [src/voice.ts](../desktop/src/voice.ts) (the microphone) and
[native/transcribe.m](../desktop/native/transcribe.m) (the macOS recognizer).
Drawing is `startAnnotation()` in [main.ts](../desktop/main/main.ts), the
`ScreenAnnotation` component in [App.tsx](../desktop/src/App.tsx), and
[shared/screen-context.ts](../desktop/shared/screen-context.ts).

## Dictation is off until you turn it on

`transcriptionEnabled` defaults to `false`. It is a microphone, so it is opt-in.
Settings → Voice is the switch, and `voiceReady()` will not let the island
record until three things hold:

```
transcriptionEnabled && microphone === "granted" && speech
```

When one of them does not, `voiceBlocker()` names the single thing in the way —
*"Voice is off"*, *"Microphone access is not granted"*, or whatever the engine
said — and the island hands you over to the workspace rather than trying to fix
it in place. That is deliberate: the macOS microphone prompt takes focus, and an
island that loses focus closes, taking the half-finished setup with it. The ●
button on a not-ready island calls `openWorkspace("voice")`, which lands you on
the page that sets it up.

## Recording happens in the renderer

`record()` in [src/voice.ts](../desktop/src/voice.ts) opens
`getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })`
and runs a `MediaRecorder`, because that is where `MediaRecorder` lives. The
track is stopped as soon as the recording ends, which is what turns the orange
recording dot off, and a window that closes mid-recording cancels first.

`MediaRecorder` on this platform produces WebM/Opus, and llama.cpp's decoder
sniffs the container by magic bytes and only accepts RIFF/WAVE, MP3 or FLAC. So
the renderer decodes and rewrites it before it leaves: an `OfflineAudioContext`
at **16 kHz** resamples it, every channel is averaged into one, and `wav()`
writes a canonical 44-byte RIFF header and 16-bit PCM. 16 kHz mono is what the
ASR front end resamples to anyway, and it keeps a minute of speech near 2 MB
instead of tens.

Everything after that is main's, for two reasons: a sandboxed `file://`
renderer cannot fetch localhost or spawn a helper, and "it stays on this Mac" is
a rule that has to be enforced somewhere the page cannot reach.

The two IPC handlers are `emma:voice-status` and `emma:transcribe`. Both go
through `trustedFrame()`, and both re-validate what they are handed:
`validateUtterance()` requires a real `ArrayBuffer`, non-empty, at most
**12 MiB** (`MAX_UTTERANCE_BYTES`), with a MIME type matching
`audio/[a-z0-9.+-]{1,32}`; `validateVoiceSettings()` re-checks the settings
object, because the renderer holds the user's settings and ships them with each
call, which makes them untrusted input twice over.

## Two engines

`transcriptionEngine` is `"apple"` or `"server"`. Default is `"apple"`.

### macOS, built in

The recognizer macOS already ships — the same on-device engine as system
dictation — reached through Speech.framework by a helper binary. Nothing to
install and nothing to keep running, at the cost of a model Emma does not
choose.

`desktop/native/transcribe.m` builds to `emma-transcribe`. From the
`build:native` script in [package.json](../desktop/package.json):

```
clang -O2 -mmacosx-version-min=12.0 -fobjc-arc \
  -framework Foundation -framework Speech \
  native/transcribe.m -o dist-native/emma-transcribe
```

It is a spawned binary rather than a native module because Node cannot call
Speech.framework and a native module for one framework call is not worth the
build. Its contract is two lines wide:

```
emma-transcribe --check [locale]   → prints "ready", or why not; exit 1 if not
emma-transcribe <wav>   [locale]   → prints the transcript on stdout
```

The stderr sentence is written to be shown to the user unchanged, because it
names the switch that is off.

**On-device is the rule, not a preference.** `requiresOnDeviceRecognition = YES`
is pinned on every request, so a Mac whose locale has no downloaded model fails
loudly rather than quietly uploading the recording to Apple. `recognizer()`
refuses, in order, when: authorization is denied or restricted, macOS has no
recognizer for the locale, the recognizer is unavailable,
`supportsOnDeviceRecognition` is false ("Add the language under System Settings
→ Keyboard → Dictation"), or **Dictation itself is off** — read from the
`Dictation Enabled` key in `com.apple.assistant.support`, because there is no
API for that switch and without the check the failure arrives at dictation time
rather than at `--check` time.

The request also sets `shouldReportPartialResults = NO`,
`taskHint = Dictation`, and `addsPunctuation = YES` on macOS 13+. Speech.framework
reads a URL, so the WAV touches disk — a `mkdtemp` directory, mode `0600`,
deleted in a `finally` whether or not recognition succeeded.

Two more things.

- TCC reads the **responsible** process's `Info.plist`, not the helper's, so
  `NSSpeechRecognitionUsageDescription` lives in Emma.app's plist via
  `--extend-info native/Info.extra.plist` in `package:mac`. Without it, TCC does
  not refuse the process — it aborts it. That is what `npm run dev` hits, and
  `died()` translates the silent death into *"macOS stopped Emma's speech
  helper. The built-in recognizer needs the packaged Emma.app —
  `npm run package:mac`."*
- The first `--check` raises the Speech Recognition prompt and blocks on it, so
  it gets a **60 s** timeout (`AUTHORIZE_TIMEOUT`) rather than the probe's 1.5 s.
  Settings has a `Speech Recognition ↗` button that opens the pane directly.

### A local `/v1/audio/transcriptions` server

Better words — especially names and technical terms — at the cost of running a
server. It is an ordinary OpenAI-shaped multipart POST: `file`, `model`,
`response_format=json`, answer read from `.text`.

Both halves of voice run on llama.cpp, which is Metal-accelerated, does
multimodal input through libmtmd, and whose server speaks both routes the
pipeline needs. From [shared/voice.ts](../desktop/shared/voice.ts):

```
brew install llama.cpp
llama-server -hf ggml-org/Qwen3-ASR-0.6B-GGUF --port 8080
```

Defaults: endpoint `http://127.0.0.1:8080/v1/audio/transcriptions`, model
`ggml-org/Qwen3-ASR-0.6B-GGUF`. Timeout is **120 s** — Whisper-class models on a
laptop are not instant, and a long utterance is worth waiting out. Failure
messages name the fix: *"No speech-to-text server answered at … Start one in
Settings → Voice"*, or *"The speech-to-text server answered 500. Check the model
name in Settings → Voice."*

Settings shows whether the engine is alive: `speechReady()` runs `--check` for
the macOS engine, and for the server engine it fetches the *origin* with a
**1.5 s** timeout — a 404 still means a server is there.

## Cleaning the transcript up

Stage two is optional and never fatal. `superwhisper/s1-mini-GGUF` is a 0.6B
**text** model — not a speech model — that rewrites a raw transcript as written
English: fillers dropped, false starts resolved, punctuation, numbers and dates
rendered properly. It reads what stage one heard, so it can only ever be the
second half.

```
llama-server -hf superwhisper/s1-mini-GGUF:Q4_K_M --jinja \
  --chat-template-kwargs '{"enable_thinking":false}' --temp 0 --port 8081
```

Defaults: `http://127.0.0.1:8081/v1/chat/completions`, `voiceCleanup: true`.
Emma re-sends `temperature: 0`, `top_p: 1`, `max_tokens: 512` and
`chat_template_kwargs: { enable_thinking: false }` on every request, because the
GGUF's inherited metadata carries Qwen3-0.6B's `temp = 0.6` and defaults
thinking mode on — neither of which S1-mini was trained for. Timeout is **20 s**.

The prompt is verbatim from the model card, since S1-mini is not a chat model
and does not follow general instructions: a fixed system line, then
`[Styling: semi-formal] [Structure: prose] [Context: general]`, then one raw
transcript.

**A cleanup that fails hands back the raw transcript.** `polish()` never throws.
It returns `raw` when cleanup is off, when the text is blank, when the endpoint
is not local, when the response is not `ok`, and inside a bare `catch`.
`cleanedTranscript()` adds two more guards on the answer itself:

- a leaked `<think>…</think>` block is stripped rather than typed into the
  composer;
- an answer longer than `raw.length * 3 + 80` is the model having talked *about*
  the transcript instead of rewriting it — thinking left on, or a different
  model under the same name — so the raw text wins;
- an empty answer is real (pure filler cleans to nothing), but only when there
  was little to clean: under 24 characters of raw. Otherwise the raw text wins.

A rough transcript is worth far more than an error where the words should be.

`voiceStatus()` also lists what the cleanup server is serving (`/v1/models`,
first 64 ids) so Settings can distinguish *"Server running · S1-mini not
loaded"* from *"Model loaded"*. `isVoiceModel()` matches `/s1[-_]mini/i`.

## Every endpoint must be local

The enforcement is one function, `localEndpoint()` in
[shared/settings.ts](../desktop/shared/settings.ts):

```ts
export function localEndpoint(value: string): URL | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? url : null;
  } catch { return null; }
}
```

Hostname allowlist, not a pattern. `192.168.x.x` is not local. A DNS name that
happens to resolve to loopback is not local. Anything it rejects returns `null`,
and every caller treats `null` as "do not send".

It runs everywhere the settings cross a boundary:

| Where | What |
| --- | --- |
| `validateSettings()` | `transcriptionEndpoint`, when dictation is on and the engine is `server` — throws *"Transcription endpoint must be local"* |
| `validateSettings()` | `voiceCleanupEndpoint`, always — throws *"The transcript cleanup endpoint must be local"* |
| `transcribe()` in main | re-checks before the POST; throws *"The speech-to-text endpoint must be a local address."* |
| `polish()` in main | re-checks; a non-local endpoint silently returns the raw transcript |
| `speechReady()` / `voiceStatus()` | re-checks before probing |

The re-check in main is not redundant. The settings live in the renderer and
ride along with each IPC call, so main validates them again every time rather
than trusting what it is handed. Same rule, one function, checked at every
crossing.

## Microphone permission

There is no API to ask for the microphone without recording, so
`Settings → Voice → 1 · Microphone` has a button that starts a recording and
immediately throws the audio away. macOS raises its prompt the first time, and
only the user can answer it.

Status comes from `systemPreferences.getMediaAccessStatus("microphone")` and
Settings spells it out:

| Status | Shown as | Button |
| --- | --- | --- |
| `granted` | Granted | Re-check |
| `not-determined` | Not asked yet | Ask for the microphone |
| `denied` | Refused — macOS is blocking it | Open System Settings ↗ |
| `restricted` | Blocked by this Mac's policy | Open System Settings ↗ |

Denied and restricted cannot be recovered in-app — macOS only lets the user
change it. The button deep-links to **System Settings → Privacy & Security →
Microphone** via `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`.
The pane name comes from a table in
[shared/setup.ts](../desktop/shared/setup.ts), not from the caller, so a
renderer cannot talk main into opening an arbitrary `x-apple.systempreferences:`
URL. The microphone is not one of the three grants the first-launch walkthrough
asks for; Settings → Voice is the only place it comes up.

If the recording itself fails to start, the island says
*"Emma could not open the microphone. Grant it in Settings → Voice."* and
re-probes.

## Hold to talk

In the island, hold the space bar while the composer is empty, say your piece,
and let go. `useSpaceHold()` only opens the microphone if the press outlives
`voiceHoldMs` — a tap is still a space, and the composer may want it. Choices
are 200 / 300 / 400 / 600 / 800 ms; the default is **400**.

Two guards keep it from eating the space bar mid-sentence: the hook is armed
only while the composer is empty and nothing is running, and any of ⌘/⌃/⌥ or a
key repeat cancels. Losing the window mid-hold (`blur`) cancels the recording
too, since there would be no key left to release.

The same thing is on the ● button in the island's action row and on the
**Quick Ask with voice** keybind (see [notch.md](notch.md)).

Dictation **lands in the composer, it does not send**. What comes back is a
first draft of a sentence and is worth a glance. If the composer already has
text, the transcript is appended after a space.

Settings → Voice step 5 runs the identical path with a hold-to-talk button, so
what it shows you is exactly what the island would have typed.

## Drawing

The ✎ button on the island — and the `draw` orb, and the **Draw on the screen**
keybind — opens a pen you use on your own live screen.

`startAnnotation()` hides the overlay and opens a full-display, transparent,
always-on-top panel with an accent-coloured inset ring saying the mode is armed.
The canvas covers the display at `devicePixelRatio`, the cursor is a crosshair,
and the strokes are a fixed yellow highlighter: `#ffe84f`, 5 px wide, round caps
and joins, with a `#fff46b` 14 px glow, all scaled by DPR. Escape cancels.

There is nothing to draw *on*. The sheet is transparent and the real screen
shows through it, so the picture underneath does not exist yet — which is the
point: you are marking up the live screen, not a frozen screenshot of it.

**700 ms** after the last stroke (`SETTLE_MS`) the drawing settles and the
renderer asks main for the frame. Main hides the sheet, waits 120 ms, captures
the display *and* reads which app is actually in front — that is the same moment
the real front app becomes visible again — and hands the frame back. The
renderer composites the captured frame and the stroke canvas onto one canvas at
the frame's own size, encodes JPEG at 0.8, and posts it to
`emma:finish-screen-annotation`. Main re-validates it as a JPEG data URL,
re-compresses it under the host's ceiling, stores it, closes the sheet and
brings the island back.

The plain **▣ Screen** orb is the same pipeline without the drawing step: hide
the overlay, 120 ms, capture, compress, attach.

Capture and compression, both in
[main/computer.ts](../desktop/main/computer.ts):

- `captureDisplay()` grabs at up to 2560 × 1600 device pixels and encodes JPEG
  at quality 82. If Screen Recording is denied or restricted it throws
  *"Screen Recording permission is required. Enable Emma in System Settings →
  Privacy & Security → Screen Recording."*
- `compressScreenFrame()` walks widths 1440 → 1200 → 960 → 720 and, at each,
  qualities 68 → 54 → 42 → 32, taking the first result under
  `MAX_SCREEN_CONTEXT_CHARS` (**96 KiB**). Quality is coarsened before
  resolution, so coordinates stay usable as long as possible.

### What it produces

One attachment, held by `ScreenContextStore` in
[shared/screen-context.ts](../desktop/shared/screen-context.ts). One slot, with
a claim/finish handshake around it:

- `put()` replaces whatever was there — one capture at a time;
- `claim(id)` throws if the id is unknown or another send already holds it;
- `finish(id, delivered)` clears it **only when the turn was delivered**, so a
  failed send keeps the picture and a successful one cannot be replayed;
- ids must match `^[a-z0-9-]+$` and be ≤ 128 chars.

In the island the attachment shows as an 84 × 52 thumbnail chip with an × to
discard it, and the island claims a 60 pt band for it so it is never clipped.
It rides along with the next ask — a typed one or a quick action — and that is
the only thing that consumes it.

Main attaches it in the `sendMessage` path, and only from the overlay's own
`webContents`. Alongside the image it adds one sentence of attached context
from `frontApplicationNote()`:

> The attached screen capture is the user's own screen. The app they had in
> front was "…", window "…".

A picture of a screen says nothing about whose screen it is, and the model needs
to be told. Emma itself is never the answer — `frontApplication()` filters out
Emma and Electron.

## See also

- [notch.md](notch.md) — the island, the ✎ button, the orbs and the keybinds
- [permissions.md](permissions.md) — what an ask carrying a capture may do
- [privacy.md](privacy.md) — what leaves this Mac and what does not
- [models.md](models.md) — local model profiles, which use the same localhost rule
- [computer-use.md](computer-use.md) — the other user of `captureDisplay`
- [troubleshooting.md](troubleshooting.md) — when nothing is heard
- [design-system.md](design-system.md) — fonts and the rest of the visual language
- [getting-started.md](getting-started.md) · [concepts.md](concepts.md)
