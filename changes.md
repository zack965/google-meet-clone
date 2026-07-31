# Architecture: Silence-Based Audio Segmentation & AI Voice Round-Trip

This document describes the proposed architecture for capturing full meeting
audio, detecting silence, saving audio segments (last-silence → now), and
running each segment through an AI pipeline (speech → text → speech) that
streams the resulting audio back into the meeting.

No code has been changed — this is a design reference only.

## Signal chain (client → server → AI controller → client)

```
Chime meeting audio (local mic + all remote attendees)
   │  Web Audio API taps into the raw streams Chime already gives you
   ▼
VAD / silence detector (per-frame RMS in an AudioWorklet)
   │  emits "speech start" / "silence start" events
   ▼
Rolling MediaRecorder buffer, cut into a Blob on each silence boundary
   │  segment = [previous silence-end … now]
   ▼
Upload Blob to a new Laravel endpoint (multipart)
   ▼
Controller stores file (Storage disk) + creates an AudioSegment row
   ▼
Dispatches a queued Job → AI Controller pipeline:
   1. Speech-to-text on the segment
   2. sleep(1) second
   3. Text-to-speech of the resulting text
   ▼
Resulting audio streamed back down to the client
   ▼
Client plays the synthesized audio into the meeting (as an audio input)
```

## 1. Client — capturing *full meeting* audio, not just your own mic

`resources/js/hooks/use-chime-meeting.ts` currently only wires local mic in/out
and per-attendee volume (`realtimeSubscribeToVolumeIndicator`, line 172). To
get full control of the meeting's audio (everyone, not just yourself) two
Chime SDK hooks that aren't used yet are needed:

- `session.audioVideo.addAudioMixObserver({ meetingAudioStreamDidChange })` —
  gives the actual mixed `MediaStream` of every remote participant as it's
  played out. This is the "whole meeting" audio.
- The existing local mic stream from `startAudioInput` (line 108) — your own
  voice, since the mix observer only carries *remote* audio.
- Combine both via a Web Audio API `AudioContext` + two
  `MediaStreamAudioSourceNode`s → a `ChannelMergerNode` (or two `GainNode`s
  into one `MediaStreamAudioDestinationNode`) to get one merged stream = the
  full call.

This logic doesn't belong bolted onto `use-chime-meeting.ts` — it's a separate
concern. Proposed new hook: **`resources/js/hooks/use-silence-recorder.ts`**,
which takes the merged `MediaStream` and does steps 2–3 below. It would be
wired in from **`resources/js/pages/meetings/show.tsx`** (where
`useChimeMeeting` is already called at line 27), alongside `CallRoom`.

## 2. Client — silence detection (VAD)

Inside `use-silence-recorder.ts`:

- `AudioContext` + `AudioWorkletNode` (not the deprecated `ScriptProcessorNode`)
  running a small worklet that computes RMS volume per audio frame.
- A simple state machine: `speaking` → `silence` when RMS stays below a
  threshold for e.g. 500–800ms (debounced, same idea as
  `SPEAKING_VOLUME_THRESHOLD` already defined at line 27 of
  `use-chime-meeting.ts`, just applied to raw PCM instead of Chime's own
  volume indicator).
- Chime's built-in `realtimeSubscribeToVolumeIndicator` per attendee could be
  reused instead of a raw VAD, but that only tells you "is this one attendee
  talking," not "is the whole meeting silent" — for whole-meeting silence the
  merged-stream approach above is required.

## 3. Client — chunking + upload

- `MediaRecorder` on the merged stream, running continuously with small
  `ondataavailable` timeslices (e.g. 250ms), pushed into an in-memory array.
- Keep a `segmentStartAt` timestamp = end of the previous silence.
- On each new "silence start" event: stop accumulating, join the buffered
  chunks into one `Blob` (webm/opus), reset the buffer, set
  `segmentStartAt = now`.
- POST that Blob immediately to a new backend route via `useHttp` (same
  pattern already used in `use-chime-meeting.ts` line 39 for
  `fetchAttendeeName`).

## 4. Server — storage + job dispatch (none of these exist yet)

Following the existing `AttendeeController` pattern
(`app/Http/Controllers/AttendeeController.php`):

- **Route** in `routes/web.php`, alongside the existing
  `meetings/{meeting:uuid}/attendees` group:
  `POST meetings/{meeting:uuid}/attendees/{awsAttendeeId}/audio-segments`
- **Controller**: `app/Http/Controllers/AudioSegmentController.php` — validates
  the upload, stores it (`Storage::disk(...)->putFile(...)`, current
  `FILESYSTEM_DISK=local`, swap to `s3` for production), creates the DB row,
  dispatches the job.
- **Migration + Model**:
  `database/migrations/..._create_audio_segments_table.php` +
  `app/Models/AudioSegment.php`, mirroring `Meeting`/`Attendee`
  (`database/migrations/2026_07_27_145105_create_attendees_table.php` is the
  closest sibling to copy conventions from). Columns: `meeting_id`,
  `attendee_id`, `path`, `started_at`, `ended_at`, `status`.

## 5. Server — AI Controller pipeline (speech → text → speech)

- **Job**: `app/Jobs/ProcessAudioSegmentJob.php` (no `app/Jobs` dir exists yet)
  implementing `ShouldQueue` — dispatched right after the `AudioSegment` row
  is created. `QUEUE_CONNECTION=database` is already configured, so
  `php artisan queue:work` picks it up with zero extra setup.
- **Controller/Service**: `app/Http/Controllers/AiVoiceController.php` (or a
  plain `app/Services/AiVoiceService.php` invoked by the job — service class
  preferred so it's reusable outside HTTP context) does the actual
  transformation, called from within the job:
  1. **Speech-to-text**: send the stored segment audio to a transcription
     provider (e.g. AWS Transcribe, since `aws/aws-sdk-php` is already a
     dependency, or an LLM audio endpoint) → plain text.
  2. `sleep(1)` — a deliberate 1 second pause between transcription and
     synthesis (e.g. to simulate "thinking time" or throttle downstream
     calls).
  3. **Text-to-speech**: send the resulting text to a TTS provider (e.g. AWS
     Polly) → a new audio file.
  4. Store the synthesized audio (new `AudioSegment`-like row or a
     `response_path` column on the same row) and mark the segment `status`
     as `completed`.
- Because `sleep(1)` blocks the queue worker for a full second per segment,
  this job should run on its own queue (e.g. `ai-voice`) so it doesn't starve
  other queued work — configure via `->onQueue('ai-voice')` and a dedicated
  `php artisan queue:work --queue=ai-voice` worker.

## 6. Client — streaming the AI's audio back into the meeting

- The client needs to know when a segment's synthesized audio is ready.
  Options, in order of fit with the existing stack:
  - **Reverb/Echo broadcast** (if configured) — broadcast an event
    (`AudioSegmentProcessed`) with the resulting audio URL, listened to on
    the meeting's channel.
  - Polling fallback — `useHttp` re-fetch on an interval while a segment is
    `pending`.
- Once the URL is available, fetch the audio and decode it
  (`AudioContext.decodeAudioData`) into an `AudioBufferSourceNode`.
- To actually inject that audio into the Chime call (so other attendees hear
  it), it can't just be played through a `<audio>` tag — it has to become the
  meeting's audio input:
  - Route the decoded buffer into a `MediaStreamAudioDestinationNode`, giving
    a `MediaStream` of just the synthesized speech.
  - Swap Chime's active audio input to that stream via
    `session.audioVideo.startAudioInput(syntheticStream)` for the duration of
    playback, then switch back to the real microphone stream afterward
    (`startAudioInput(originalMicStream)`).
  - Because `startAudioInput` fully replaces the input device, the local
    mic should be muted/ignored while the synthetic clip plays, to avoid
    talking over the AI's response.

## Alternative worth noting

Since `aws/aws-sdk-php` and `ChimeSDKMeetingsClient` are already dependencies
(`app/Http/Controllers/AttendeeController.php`), AWS also offers Chime SDK
Media Capture/Insights Pipelines — server-side recording + live Transcribe
integration with no client-side VAD needed. It's a legitimate alternative for
step 1 (capture + transcription), but it doesn't help with step 6 (streaming
synthesized audio back into the live call), which still requires a client-side
`startAudioInput` swap regardless of how the original audio was captured.
