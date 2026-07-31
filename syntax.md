# Syntax changes required to implement `changes.md`

This is a reference list of the concrete code/syntax changes needed to implement the
silence-based audio segmentation + AI voice round-trip architecture described in
`changes.md`, given the current code documented in `README.md`. No source files have been
modified — this is planning reference only.

## 1. `resources/js/hooks/use-chime-meeting.ts` — needs to expose what it currently hides

Right now `sessionRef`, the mic stream, and `audioVideo` are all private to this hook. The
silence recorder needs access to both the merged meeting audio and the raw local mic stream,
so this hook must start exposing them:

```ts
// new: keep a ref to the raw mic stream (currently discarded after startAudioInput)
const localAudioStreamRef = useRef<MediaStream | null>(null);

// inside join(), after startAudioInput:
localAudioStreamRef.current = await session.audioVideo.startAudioInput(
    audioInputDevices[0]?.deviceId ?? null,
);
```
Note: `startAudioInput` currently isn't awaited-and-stored — its return value (the stream) is
thrown away. That has to change to a captured variable.

```ts
// new: expose the session itself (or at minimum audioVideo) so use-silence-recorder
// can call addAudioMixObserver / startAudioInput(syntheticStream) on it.
return {
    connectionState,
    isMuted,
    roster: Object.values(roster),
    join,
    leave,
    toggleMute,
    audioVideo: sessionRef.current?.audioVideo ?? null,   // new
    localAudioStream: localAudioStreamRef.current,         // new
};
```
`sessionRef`/`localAudioStreamRef` being refs means the returned values above won't trigger
re-renders on change — surfacing them through a callback (`onSessionReady`) or a small piece
of state instead of reading `.current` directly at return time is a real design decision to
make before writing it, not just a copy-paste.

## 2. `resources/js/hooks/use-silence-recorder.ts` — currently an empty stub, needs the actual implementation

Per `changes.md` §1–3, the shape would be:

```ts
export function useSilenceRecorder(
    audioVideo: AudioVideoFacade | null,
    localAudioStream: MediaStream | null,
    onSegment: (blob: Blob) => void,
) {
    useEffect(() => {
        if (!audioVideo || !localAudioStream) return;

        let remoteStream: MediaStream | null = null;
        audioVideo.addAudioMixObserver({
            meetingAudioStreamDidChange: (stream) => { remoteStream = stream ?? null; },
        });

        const audioContext = new AudioContext();
        const destination = audioContext.createMediaStreamDestination();
        audioContext.createMediaStreamSource(localAudioStream).connect(destination);
        if (remoteStream) audioContext.createMediaStreamSource(remoteStream).connect(destination);

        // AudioWorkletNode for RMS-based VAD, MediaRecorder on destination.stream,
        // state machine speaking/silence, Blob assembly on silence-start → onSegment(blob)
    }, [audioVideo, localAudioStream]);
}
```
Key new syntax elements not used anywhere else in the codebase yet: `AudioWorkletNode`,
`audioContext.audioWorklet.addModule(...)` (needs a separate worklet JS file, e.g.
`public/worklets/rms-processor.js`), `MediaRecorder`, `createMediaStreamDestination`.

## 3. `resources/js/pages/meetings/show.tsx` — new wiring

```ts
const chime = useChimeMeeting(meeting.uuid);
useSilenceRecorder(chime.audioVideo, chime.localAudioStream, (blob) => {
    const formData = new FormData();
    formData.append('audio', blob);
    post(AudioSegmentController.store([meeting.uuid, attendeeId]).url, formData);
});
```
This requires a Wayfinder-generated `AudioSegmentController` (`php artisan wayfinder:generate`
after the controller/route below exist) plus `useHttp`'s `post` supporting `FormData`
(multipart), which isn't exercised anywhere else in the current frontend —
`AttendeeController::store` posts plain JSON.

## 4. Backend — new syntax, nothing to modify, only to add

- `routes/web.php`: one new line,
  `Route::post('meetings/{meeting:uuid}/attendees/{awsAttendeeId}/audio-segments', [AudioSegmentController::class, 'store'])`
- `app/Http/Controllers/AudioSegmentController.php`: `$request->validate(['audio' => 'required|file'])`,
  `$request->file('audio')->store(...)`, `AudioSegment::create([...])`,
  `ProcessAudioSegmentJob::dispatch($segment)->onQueue('ai-voice')`
- `app/Jobs/ProcessAudioSegmentJob.php`: new class, `implements ShouldQueue`, `use Queueable;`
- `app/Models/AudioSegment.php` + matching migration: standard Eloquent model syntax, no
  precedent to deviate from (`Meeting`/`Attendee` are the closest siblings).
