# ChimeDemo — an audio-only Google Meet clone on AWS Chime SDK

This app lets a signed-in user spin up a voice meeting and share a link. Anyone with the
link can join as a guest by typing just their name — no account required. Everyone in the
call can mute/unmute, see who's talking (a live speaking indicator), see a roster of
participants, and leave; the meeting owner can end it for everyone. There is **no video and
no screen share** — audio only, by design.

It's built on **Amazon Chime SDK for Meetings**, which does all the hard real-time work
(signaling, WebRTC media routing, active-speaker/volume detection, participant presence) for
you. Laravel's job is just to hand out short-lived credentials for a meeting; your browser
talks to AWS directly for the actual audio. That split is the single most important thing to
understand about this codebase — see [How it fits together](#how-it-fits-together) below.

This document is written so you can lift the pattern into your own project. It explains
*why* each piece exists, not just what it does.

---

## Table of contents

- [How it fits together](#how-it-fits-together)
- [AWS setup](#aws-setup)
  - [IAM policy JSON](#iam-policy-json)
- [Two SDKs, two jobs](#two-sdks-two-jobs)
- [Data model](#data-model)
- [Backend walkthrough](#backend-walkthrough)
  - [Binding the Chime client](#binding-the-chime-client)
  - [MeetingController](#meetingcontroller)
  - [AttendeeController](#attendeecontroller)
  - [MeetingPolicy](#meetingpolicy)
  - [Routes](#routes)
- [Frontend walkthrough](#frontend-walkthrough)
  - [The `useChimeMeeting` hook](#the-usechimemeeting-hook)
  - [The Lobby (pre-join screen)](#the-lobby-pre-join-screen)
  - [The call room](#the-call-room)
  - [The page state machine](#the-page-state-machine)
- [End-to-end sequence](#end-to-end-sequence)
- [Gotchas we hit (and fixed)](#gotchas-we-hit-and-fixed)
- [Testing strategy](#testing-strategy)
- [Extending this](#extending-this)
- [Environment variables](#environment-variables)

---

## How it fits together

```
┌──────────────┐        1. POST /meetings                 ┌──────────────────┐
│   Browser    │ ─────────────────────────────────────────▶│  Laravel backend  │
│  (owner)     │                                            │                  │
│              │        2. createMeeting() via PHP SDK      │  MeetingController│
│              │◀──────────────── redirect ─────────────────│                  │
│              │        3. GET /meetings/{uuid}             └────────┬─────────┘
│              │◀───────────── Inertia page ──────────────────────────┘
│              │
│              │        4. POST /meetings/{uuid}/attendees
│              │ ───────────────────────────────────────────▶ AttendeeController
│              │        5. createAttendee() via PHP SDK        (createAttendee)
│              │◀────────── { meeting, attendee } JSON ────────────────┘
│              │
│              │        6. amazon-chime-sdk-js opens a WebSocket + WebRTC
│              │            connection DIRECTLY to AWS media servers,
│              │            using the join token from step 5.
│              │
│  ┌───────────▼────────────┐      audio, presence, mute state, volume
│  │  AWS Chime SDK media    │◀────────────────────────────────────────▶ other
│  │  backend (WebRTC/SFU)   │                                           attendees'
│  └─────────────────────────┘                                           browsers
└──────────────┘
```

The key idea: **Laravel never touches audio.** Its only two jobs are (1) calling the AWS
Chime Meetings API to create a `Meeting` and `Attendee` resource, and (2) handing the
resulting JSON to the browser. Once the browser has that JSON, `amazon-chime-sdk-js` opens
its own connection straight to AWS and Laravel is out of the loop until someone ends the
meeting or needs another attendee's display name.

This is why there's no Reverb/Pusher/websockets anywhere in this app — Chime's own
real-time layer replaces that entirely for the call itself.

## AWS setup

You need:

1. An AWS account with an IAM user/role that has, at minimum, the permissions in
   [IAM policy JSON](#iam-policy-json) below — Chime SDK Meetings for the call itself, plus
   Transcribe/Polly/S3 for the AI voice round-trip (`AiController`). The AWS-managed policy
   `AmazonChimeSDK` covers the Chime half if you'd rather attach a managed policy for that
   part and only hand-roll the Transcribe/Polly/S3 statements.
2. Access key + secret for that principal, placed in `.env`:
   ```
   AWS_ACCESS_KEY_ID=...
   AWS_SECRET_ACCESS_KEY=...
   AWS_DEFAULT_REGION=us-east-1
   AWS_BUCKET=...
   ```
   Chime SDK Meetings is only available in a handful of regions (e.g. `us-east-1`,
   `us-west-2`, `eu-central-1`...) — check the [AWS docs](https://docs.aws.amazon.com/general/latest/gr/chime-sdk.html)
   for the current list. `config('services.aws.region')` is used both as the AWS client
   region *and* as the Chime `MediaRegion` (where the actual audio gets routed) — you can
   split these if you want meetings routed to a region different from your API calls.
3. Meetings and Attendees themselves are ephemeral AWS resources — you don't provision them
   ahead of time, you just call the API and AWS spins them up on demand, and they auto-expire
   after a period with no connected attendees. The one persistent resource you *do* need to
   create yourself is the S3 bucket named by `AWS_BUCKET` — `AiController` uses it only as a
   transient scratch space for Amazon Transcribe (which requires an S3 input/output URI); it
   uploads a segment, waits for the transcription job, then deletes both the input and output
   objects immediately after (`AiController::transcribeAudio`'s `finally` block) — nothing is
   left in the bucket between requests.

### IAM policy JSON

Least-privilege policy for the IAM user/role behind `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` — covers exactly the AWS calls this codebase makes (`MeetingController`,
`AttendeeController`, `AiController`). Replace `YOUR_BUCKET_NAME` with the value of `AWS_BUCKET`.

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ChimeSDKMeetings",
            "Effect": "Allow",
            "Action": [
                "chime:CreateMeeting",
                "chime:DeleteMeeting",
                "chime:CreateAttendee"
            ],
            "Resource": "*"
        },
        {
            "Sid": "TranscribeSegments",
            "Effect": "Allow",
            "Action": [
                "transcribe:StartTranscriptionJob",
                "transcribe:GetTranscriptionJob",
                "transcribe:DeleteTranscriptionJob"
            ],
            "Resource": "*"
        },
        {
            "Sid": "PollySynthesis",
            "Effect": "Allow",
            "Action": [
                "polly:SynthesizeSpeech"
            ],
            "Resource": "*"
        },
        {
            "Sid": "TranscribeScratchSpace",
            "Effect": "Allow",
            "Action": [
                "s3:PutObject",
                "s3:DeleteObject"
            ],
            "Resource": [
                "arn:aws:s3:::YOUR_BUCKET_NAME/transcribe-input/*",
                "arn:aws:s3:::YOUR_BUCKET_NAME/transcribe-output/*"
            ]
        }
    ]
}
```

`chime:*`, `transcribe:*`, and `polly:SynthesizeSpeech` all require `Resource: "*"` — none of
them support resource-level ARN restrictions in IAM (AWS API limitation, not a choice made
here). The S3 statement is the only one scoped down, to the two prefixes `AiController`
actually writes to inside your bucket — it deliberately does **not** grant blanket
`s3:*`/`s3:GetObject` on the bucket, since nothing in this app's own IAM principal ever reads
those objects back (Transcribe reads the input directly as a same-account service call, and
the transcript is fetched over a presigned HTTPS URL, not the S3 API).

## Two SDKs, two jobs

| | `aws/aws-sdk-php` (backend) | `amazon-chime-sdk-js` (frontend) |
|---|---|---|
| Runs where | Laravel, server-side | The browser |
| Talks to | AWS Chime **control plane** (REST API) | AWS Chime **media plane** (WebSocket signaling + WebRTC) |
| Needs AWS credentials? | Yes — this is why it must stay server-side | No — it only needs the `JoinToken` handed to it by the backend |
| What it creates | `Meeting` (a call) and `Attendee` (a seat in that call, with a secret join token) | Nothing — it *consumes* the Meeting/Attendee JSON to open a live audio session |

You cannot create a Meeting or Attendee from the browser — that requires real AWS
credentials, which must never ship to client JS. The backend's whole purpose is to be a
thin, authenticated gatekeeper: "you're allowed to join meeting X, here's your one-time
attendee credential." Everything after that is peer-to-AWS, not peer-to-your-server.

## Data model

Two tables, both intentionally thin — they're a local cache/index over AWS resources, not
the source of truth for the call itself.

**`meetings`** (`database/migrations/..._create_meetings_table.php`)

| column | purpose |
|---|---|
| `id` | normal auto-increment PK (used for FKs) |
| `owner_id` | who can end this meeting (`MeetingPolicy`) |
| `title` | optional, shown in the UI |
| `aws_meeting_id` | the Chime `MeetingId` — what you pass back to AWS for `DeleteMeeting`/`CreateAttendee` |
| `aws_meeting` | the **entire** `createMeeting` response, stored as JSON. The frontend needs this whole blob (media placement URLs etc.) to open a session, so we cache it rather than re-fetching from AWS on every join |
| `uuid` | the public, guessable-resistant identifier used in the shareable link (`/meetings/{uuid}`) — deliberately different from `id` so URLs don't leak sequential meeting counts |
| `ended_at` | set once the owner ends the meeting; `null` while live |

**`attendees`** (`database/migrations/..._create_attendees_table.php`)

| column | purpose |
|---|---|
| `meeting_id` | FK, cascade-deletes with the meeting |
| `user_id` | nullable — `null` for anonymous guests |
| `name` | **this is the whole reason this table exists.** Chime attendees have no concept of a display name; see [`AttendeeController`](#attendeecontroller) below |
| `aws_attendee_id` | the Chime `AttendeeId` |
| `aws_attendee` | the full `createAttendee` response (includes the secret `JoinToken`) |

> **Model gotcha we hit:** `Meeting` uses Laravel's `HasUuids` trait so the public `uuid`
> column isn't sequential/guessable, but that trait defaults to overwriting the **primary
> key** (`id`) with a UUID — which conflicts with the auto-increment `id` column the
> migration defines. Fix: override `uniqueIds(): array { return ['uuid']; }` so the trait
> only touches the `uuid` column and leaves `id` as a normal integer. If you copy this
> pattern (auto-increment PK + a separate public UUID for routing), you need this override
> or `Meeting::create()` will throw a `datatype mismatch` error.

## Backend walkthrough

### Binding the Chime client

`app/Providers/AppServiceProvider.php`:

```php
$this->app->singleton(ChimeSDKMeetingsClient::class, fn (): ChimeSDKMeetingsClient => new ChimeSDKMeetingsClient([
    'version' => 'latest',
    'region' => config('services.aws.region'),
    'credentials' => [
        'key' => config('services.aws.key'),
        'secret' => config('services.aws.secret'),
    ],
]));
```

Registered as a singleton and type-hinted in controller constructors
(`public function __construct(protected ChimeSDKMeetingsClient $client) {}`), rather than
`new`-ing it up per controller. Two reasons: it's shared between `MeetingController` and
`AttendeeController`, and — the big one — **it makes tests possible**. Because it's resolved
from the container, tests can swap it for a `Mockery` double with
`app()->instance(ChimeSDKMeetingsClient::class, $mock)` before hitting a route, so the whole
suite runs without calling real AWS. See [Testing strategy](#testing-strategy).

The AWS PHP SDK client methods (`createMeeting`, `createAttendee`, `deleteMeeting`, ...)
aren't real declared methods on the class — they're magic, dispatched through `__call`
based on a service model AWS ships inside the SDK (you can see the full list as `@method`
doc-comments at the top of `vendor/aws/aws-sdk-php/src/ChimeSDKMeetings/ChimeSDKMeetingsClient.php`).
Every call returns an `Aws\Result`, which behaves like an array but is fetched with `->get('Key')`.

### MeetingController

`app/Http/Controllers/MeetingController.php` — three actions:

**`store()`** — the "New meeting" button hits this.
```php
$result = $this->client->createMeeting([
    'ClientRequestToken' => (string) Str::uuid(), // idempotency key — retries with the
                                                    // same token won't create duplicates
    'ExternalMeetingId' => (string) Str::uuid(),   // your own identifier, opaque to AWS
    'MediaRegion' => config('services.aws.region'),
]);
```
The response's `Meeting` array is saved verbatim into `meetings.aws_meeting`, and the owner
is redirected straight into the call (`to_route('meetings.show', $meeting)`) — there's no
separate "meeting created" screen, matching how Google Meet drops the host straight in.

**`show()`** — the public join/lobby/call page. **No `auth` middleware** — this is the
route your shared link points at. It renders the `meetings/show` Inertia page with just
enough to build the lobby UI (`uuid`, `title`, whether the current visitor is the owner,
whether the meeting already ended). It deliberately does **not** expose `aws_meeting` here —
that's only handed out once someone actually commits to joining, via `AttendeeController`.

**`end()`** — owner-only (enforced by `MeetingPolicy`, see below). Calls `deleteMeeting`,
which immediately terminates every connected browser's Chime session — the frontend detects
this via the `audioVideoDidStop` observer (see the hook below) rather than needing a
websocket broadcast from Laravel. Idempotent: guarded by `if (! $meeting->isEnded())` so
double-clicking "End meeting" doesn't call `deleteMeeting` twice.

### AttendeeController

`app/Http/Controllers/AttendeeController.php` — this is where the "join by link, just say
your name" requirement actually lives.

**`store()`** is the join endpoint, called from the frontend Lobby:
```php
abort_if($meeting->isEnded(), 410, 'This meeting has ended.');

$validated = $request->validate([
    'name' => [Rule::requiredIf(! $request->user()), 'nullable', 'string', 'max:255'],
]);

$name = $request->user()->name ?? $validated['name'];

$result = $this->client->createAttendee([
    'MeetingId' => $meeting->aws_meeting_id,
    'ExternalUserId' => (string) Str::uuid(),
]);
```
- Guests **must** provide a name; authenticated users get their account name for free and
  don't see a name field at all (see the Lobby component).
- `ExternalUserId` is Chime's field for *your* identifier — we don't need to look anyone up
  by it later so a fresh UUID is fine; if you wanted to support "reconnect as the same
  attendee" you'd put something stable here instead.
- The response is a fresh `Attendee` (with a **secret `JoinToken`** — treat this like a
  password, it's what lets a browser join the live audio) which we store locally and return
  to the browser as `{ meeting, attendee }`. That JSON is exactly what
  `amazon-chime-sdk-js`'s `MeetingSessionConfiguration` constructor expects.

**`show($meeting, $awsAttendeeId)`** solves a real limitation of Chime: **attendees have no
display name concept in the AWS API at all** — only an opaque `AttendeeId` and whatever
`ExternalUserId` you gave it. When your browser sees a new attendee join (via
`realtimeSubscribeToAttendeeIdPresence`, see below), all it has is that ID. So the frontend
calls back to this endpoint to resolve "attendee `abc-123`" → `"Jane Doe"`, backed by the
`name` column we saved in `store()`. This is the standard pattern used in AWS's own Chime
SDK demo apps — if you've seen a Chime meeting app with a "get-attendee" endpoint, this is
why it's there.

### MeetingPolicy

`app/Policies/MeetingPolicy.php` — deliberately just one method (`end`), not the full
CRUD policy Laravel scaffolds by default. Only the owner can end a meeting:
```php
public function end(User $user, Meeting $meeting): bool
{
    return $user->id === $meeting->owner_id;
}
```
Invoked in the controller with `Gate::authorize('end', $meeting)`, which throws a 403
`AuthorizationException` for anyone else — covered by the "non-owners cannot end a meeting"
test.

### Routes

`routes/web.php`:

```php
Route::middleware(['auth', 'verified'])->group(function () {
    Route::get('dashboard', [DashboardController::class, 'index'])->name('dashboard');
    Route::post('meetings', [MeetingController::class, 'store'])->name('meetings.store');
    Route::delete('meetings/{meeting:uuid}', [MeetingController::class, 'end'])->name('meetings.end');
});

// Public join flow: anyone with the link can join as an anonymous guest.
Route::get('meetings/{meeting:uuid}', [MeetingController::class, 'show'])->name('meetings.show');
Route::post('meetings/{meeting:uuid}/attendees', [AttendeeController::class, 'store'])->name('meetings.attendees.store');
Route::get('meetings/{meeting:uuid}/attendees/{awsAttendeeId}', [AttendeeController::class, 'show'])->name('meetings.attendees.show');
```

Note the split: creating and ending a meeting requires a real account, but *joining* one
never does — those three routes have no `auth` middleware by design. `{meeting:uuid}` is
Laravel's implicit route-model-binding syntax telling it to look meetings up by the `uuid`
column (via `Meeting::getRouteKeyName()`) instead of the numeric `id`.

## Frontend walkthrough

### The `useChimeMeeting` hook

`resources/js/hooks/use-chime-meeting.ts` is the single place that talks to
`amazon-chime-sdk-js`. Everything else (`Lobby`, `CallRoom`, the page) is just UI wired to
the state this hook exposes: `{ connectionState, isMuted, roster, join, leave, toggleMute }`.

**Opening a session** (`join(name, awsMeeting, awsAttendee)`):
```ts
const logger = new ConsoleLogger('ChimeMeeting', LogLevel.WARN);
const deviceController = new DefaultDeviceController(logger, { enableWebAudio: true });
const configuration = new MeetingSessionConfiguration(
    { Meeting: awsMeeting },
    { Attendee: awsAttendee },
);
const session = new DefaultMeetingSession(configuration, logger, deviceController);
```
`awsMeeting`/`awsAttendee` are exactly the raw JSON the backend returned from
`AttendeeController::store`. `MeetingSessionConfiguration` parses out the signaling URL,
media placement, and join token from that JSON — this is the one moment the frontend and
backend contracts have to agree on shape.

**Picking a microphone and starting audio:**
```ts
const audioInputDevices = await session.audioVideo.listAudioInputDevices();
await session.audioVideo.startAudioInput(audioInputDevices[0]?.deviceId ?? null);

const audioElement = document.createElement('audio');
await session.audioVideo.bindAudioElement(audioElement);
```
We don't build a device picker UI — first available mic, always. `bindAudioElement` is what
actually makes other people's audio play out of your speakers; without it you'd have a
totally silent "successful" connection.

**Roster / presence** — this is how the participant grid stays live without any polling:
```ts
session.audioVideo.realtimeSubscribeToAttendeeIdPresence((attendeeId, present) => {
    // present === false → someone left, remove them from the roster
    // present === true  → someone joined, add a placeholder entry, then
    //                      resolve their name via AttendeeController::show
});
```
Chime calls this callback for *every* attendee, including yourself, the moment you connect
— that's what seeds the roster with "(You)" before anyone else has joined.

**Speaking indicator and mute state** — one more subscription per attendee, registered
inside the presence callback above:
```ts
session.audioVideo.realtimeSubscribeToVolumeIndicator(attendeeId, (id, volume, muted) => {
    // volume: number|null (0–1), muted: boolean|null
});
```
We treat `volume > 0.15` as "currently speaking" (`SPEAKING_VOLUME_THRESHOLD` in the hook)
and drive the glowing ring around each `ParticipantTile` off it. There's a fancier
`ActiveSpeakerDetector` API in the SDK that scores dominance across attendees (useful if you
want to auto-pin whoever's talking loudest, video-call style); we didn't need it for a flat
audio grid, but it's a one-line swap if you want a single "who's the main speaker" signal
instead of a per-tile threshold.

**Detecting the meeting being ended out from under you:**
```ts
session.audioVideo.addObserver({
    audioVideoDidStop: (sessionStatus) => {
        const code = sessionStatus.statusCode();
        if (code === MeetingSessionStatusCode.MeetingEnded /* or AudioAttendeeRemoved, TURNCredentialsForbidden */) {
            setConnectionState('ended');
        } else if (code === MeetingSessionStatusCode.Left) {
            setConnectionState('left');
        }
        // any other non-OK code → 'error'
    },
});
```
When the owner calls `DELETE /meetings/{uuid}`, Laravel calls AWS `DeleteMeeting`, and AWS
forcibly disconnects every attendee's WebRTC session — *this* observer is how each browser
finds out and shows "This meeting has ended" (`meetings/show.tsx`). No signal from Laravel
to the browser is needed; Chime's own connection teardown carries that information.

**Muting:**
```ts
session.audioVideo.realtimeIsLocalAudioMuted()
session.audioVideo.realtimeMuteLocalAudio()
session.audioVideo.realtimeUnmuteLocalAudio()
```
Purely local SDK state — no API call, instant.

**Cleanup** — `leave()` calls `audioVideo.stop()` then `session.destroy()` and removes the
injected `<audio>` element; it's also wired into a `useEffect` cleanup so navigating away or
unmounting the page always tears the session down, not just an explicit "Leave" click.

### The Lobby (pre-join screen)

`resources/js/components/meeting/lobby.tsx` — deliberately does **not** use
`amazon-chime-sdk-js` at all. Before you've joined, there's no Chime session to inspect yet,
so the mic-level meter is built with plain Web Audio API (`getUserMedia` + `AnalyserNode`),
independent of Chime. Once you click "Join now" it stops that preview stream and hands off
to the real hook — Chime opens its own `getUserMedia` call internally via
`startAudioInput`.

The join request itself goes through Inertia v3's `useHttp` hook (not a full page visit —
we need the JSON response back to feed `useChimeMeeting.join()`, and we don't want a
navigation):
```ts
const { data, setData, post, processing, errors } = useHttp({ name: authenticatedName ?? '' });
const response = await post(AttendeeController.store(meetingUuid).url);
onJoin((authenticatedName ?? data.name).trim(), response.meeting, response.attendee);
```
`AttendeeController.store(...)` here is a **Wayfinder**-generated function
(`resources/js/actions/App/Http/Controllers/AttendeeController.ts`, regenerated by
`php artisan wayfinder:generate` whenever a route/controller signature changes) — it gives
you a typed `.url` instead of hand-writing `` `/meetings/${uuid}/attendees` `` and having it
silently drift if the route changes.

### The call room

- `call-room.tsx` — header + a responsive grid of `ParticipantTile`s + the `Controls` bar.
- `participant-tile.tsx` — an `Avatar` with initials (`useInitials` hook), a ring that lights
  up (`ring-primary`) when `participant.speaking` is true, and a mic-off icon when muted.
- `controls.tsx` — mute toggle, copy-invite-link (`useClipboard` hook, plain
  `navigator.clipboard`), leave, and an owner-only "End meeting" button.

### The page state machine

`resources/js/pages/meetings/show.tsx` ties it together as a small state machine driven by
`chime.connectionState`:

```
meeting.isEnded (server prop) ──────────────────────────┐
                                                          ▼
        idle ──(click Join)──▶ connecting ──▶ connected ─┴─▶ ended / left / error
         │                                                        │
      <Lobby/>                                              <EndedScreen/>
```

- `meeting.isEnded` is a prop rendered by the server on first load — if the link is already
  dead, you never even see the Lobby.
- `connectionState === 'connecting'` shows a spinner (this covers the ~1 second where
  `useChimeMeeting.join()` is standing up the WebRTC connection).
- `'connected'` renders `<CallRoom>`.
- `'ended' | 'left' | 'error'` all render the same `<EndedScreen>` with a different message,
  and a link back to `/dashboard` (authenticated) or `/` (guest).

## End-to-end sequence

1. Owner clicks **New meeting** on the dashboard → `POST /meetings` →
   `MeetingController::store` calls AWS `createMeeting`, saves a `Meeting` row, redirects to
   `/meetings/{uuid}`.
2. That page renders the **Lobby** (owner skips the name field, sees a mic check).
3. Owner clicks **Join now** → `POST /meetings/{uuid}/attendees` →
   `AttendeeController::store` calls AWS `createAttendee`, saves an `Attendee` row, returns
   `{ meeting, attendee }` JSON.
4. Browser calls `useChimeMeeting.join(...)`, which builds a `DefaultMeetingSession` from
   that JSON and opens the real Chime connection. Roster shows just the owner.
5. Owner clicks **Copy invite link**, sends it to someone else.
6. Guest opens the link → same `/meetings/{uuid}` route (no login needed) → Lobby, types a
   name, clicks Join → same `AttendeeController::store` flow, but as a guest
   (`user_id = null`).
7. Both browsers are now independently connected to AWS Chime's media servers. Owner's
   browser gets a `realtimeSubscribeToAttendeeIdPresence` callback for the new attendee,
   fetches their name via `GET /meetings/{uuid}/attendees/{attendeeId}`, and the guest tile
   appears — live, no polling from either side needed.
8. Either side can mute; the other side's volume-indicator subscription reflects it near
   instantly.
9. Owner clicks **End meeting** → `DELETE /meetings/{uuid}` → AWS `deleteMeeting` → both
   browsers' `audioVideoDidStop` observers fire with `MeetingEnded` → both show "This meeting
   has ended."

## Gotchas we hit (and fixed)

These cost real debugging time — if you're copying this pattern, save yourself the trouble:

1. **`Meeting::create()` throws `SQLSTATE[HY000]: ... datatype mismatch`.**
   Cause: `HasUuids` trait defaults to overwriting the primary key. Fix: override
   `uniqueIds()` to return `['uuid']` instead of the default `['id']` — see
   [Data model](#data-model) above.

2. **Browser console: `ReferenceError: global is not defined`, only when actually opening a
   Chime session (not on page load).**
   Cause: `amazon-chime-sdk-js`'s dependency tree assumes a Node-style `global` object
   exists, which browsers don't have — Vite doesn't polyfill this automatically the way
   webpack used to. Fix, in `vite.config.ts`:
   ```ts
   export default defineConfig({
       define: {
           global: 'globalThis',
       },
       // ...
   });
   ```
   **This requires a full dev-server restart** (`npm run dev` / `composer run dev`), not
   just a hot reload — `define` is baked in at server start.

3. **Getting a real error message out of a failed join.** The original `join()`
   implementation had a bare `catch { setConnectionState('error') }` — great for users, useless
   for debugging, since it swallowed the actual thrown error. Always `console.error(error)`
   (or report it somewhere) before setting a generic UI state, or you'll be flying blind the
   first time something in the SDK throws.

4. **`getUserMedia` requires a secure context.** It silently fails (rejects) on plain
   `http://` unless the host is `localhost`/`127.0.0.1`. If you deploy behind a custom local
   domain over HTTP (Valet/Herd-style setups sometimes do this), the mic permission prompt
   will never appear and you'll see the Lobby's "Microphone access was denied" message even
   though the user was never actually asked. Use HTTPS (or `localhost`) for anything beyond
   local `php artisan serve` testing.

## Testing strategy

`tests/Feature/MeetingTest.php` and `tests/Feature/AttendeeTest.php` never call real AWS.
`tests/Pest.php` exposes a helper:
```php
function mockChimeClient(): \Mockery\MockInterface
{
    $mock = Mockery::mock(\Aws\ChimeSDKMeetings\ChimeSDKMeetingsClient::class);
    app()->instance(\Aws\ChimeSDKMeetings\ChimeSDKMeetingsClient::class, $mock);
    return $mock;
}
```
Because the client is resolved from the container (see
[Binding the Chime client](#binding-the-chime-client)), swapping in a Mockery double before
the request is all it takes:
```php
mockChimeClient()
    ->shouldReceive('createMeeting')
    ->once()
    ->andReturn(new Result(['Meeting' => ['MeetingId' => 'aws-meeting-id']]));

$response = $this->actingAs($user)->post(route('meetings.store'), ['title' => 'Standup']);
```
`MeetingFactory`/`AttendeeFactory` generate realistic-shaped fake AWS JSON blobs
(`aws_meeting`/`aws_attendee` columns) so tests that don't care about AWS interaction at all
(like "the meeting join page is publicly accessible") can just `Meeting::factory()->create()`
without touching the mock.

`tests/Pest.php` also enables `RefreshDatabase` globally — it was commented out in the
original scaffold, which meant every test was silently running against an unmigrated
in-memory SQLite database.

Run everything with:
```
php artisan test --compact
```

Note: none of this tests actual audio. Verifying that two browsers can genuinely hear each
other requires a real browser and a real AWS account — open the app in two browser
contexts (a normal window as the owner, an incognito window as a guest) and try it live.

## Extending this

- **Chat**: Chime SDK supports `realtimeSendDataMessage`/`realtimeSubscribeToReceiveDataMessage`
  for small peer-to-peer text messages over the same signaling channel — no extra
  infrastructure needed, same pattern as the volume-indicator subscription.
- **Video**: the SDK's `VideoTileController`/`videoTileDidUpdate` observer is the video
  equivalent of the audio pieces already wired up here (`startVideoInput`,
  `bindVideoElement` per tile). This app deliberately leaves it out.
- **Recording/transcription**: Chime SDK has managed APIs for both
  (`StartMeetingTranscription`, media capture pipelines) — these are backend-only additions
  to `MeetingController`, no frontend SDK changes required.
- **Persistent attendee identity** (so a refresh doesn't count as a new attendee): store the
  meeting UUID + your own `Attendee` row id in `sessionStorage` after joining, and check for
  it in the Lobby before showing the name form again. Not implemented here — this app treats
  every join as fresh, matching "anonymous, just say your name" simplicity.

## Environment variables

```
AWS_ACCESS_KEY_ID=       # IAM user/role, see the IAM policy JSON in "AWS setup" above
AWS_SECRET_ACCESS_KEY=
AWS_DEFAULT_REGION=us-east-1   # must be a Chime SDK Meetings-supported region
AWS_BUCKET=              # S3 bucket used as transient scratch space by AiController
```
Read via `config('services.aws.*')` (`config/services.php`), not `config('services.ses.*')`
— the `ses` block in that file is unrelated (Simple Email Service) and just happens to read
the same underlying env vars.

---

## Appendix: every client-side Chime SDK interaction, piece by piece

The [Frontend walkthrough](#frontend-walkthrough) above covers the shape of things. This
appendix goes line by line through every place client code touches `amazon-chime-sdk-js`
(and, for contrast, the one place it *doesn't* — the Lobby's mic preview). If you're porting
this pattern into your own app, this is the part to read closely: almost all of the
Chime-specific logic in the whole project lives in one file,
`resources/js/hooks/use-chime-meeting.ts`. Everything outside that file only ever touches
the plain JS/TS values the hook returns (`connectionState`, `roster`, `isMuted`) — no other
component imports from `amazon-chime-sdk-js` at all. That boundary is deliberate: it means
you could swap the whole SDK integration out later without touching a single UI component.

### The imports

```ts
import {
    ConsoleLogger,
    DefaultDeviceController,
    DefaultMeetingSession,
    LogLevel,
    MeetingSessionStatusCode,
    MeetingSessionConfiguration,
} from 'amazon-chime-sdk-js';
```

These are the five building blocks the SDK expects you to compose yourself — there is no
single "connect" call. Roughly:

| Import | What it is |
|---|---|
| `MeetingSessionConfiguration` | Parses the raw JSON your backend returned (`createMeeting`/`createAttendee` responses) into the URLs, IDs, and join token the SDK needs internally. Pure data, no side effects when constructed. |
| `DefaultDeviceController` | Owns device access — enumerating/selecting microphones, and (per the `enableWebAudio` option) routing audio through the Web Audio API instead of a plain `<audio>` tag, which is what lets the SDK measure per-attendee volume. |
| `DefaultMeetingSession` | The actual session object. Combines the configuration + device controller into something with an `.audioVideo` facade you call everything else through. Constructing it does **not** connect to anything yet — that only happens on `.audioVideo.start()`. |
| `ConsoleLogger` / `LogLevel` | The SDK is chatty internally (ICE negotiation, reconnection attempts, etc.) and wants an explicit logger injected — there's no default. `LogLevel.WARN` keeps that noise out of the console while still surfacing real problems. |
| `MeetingSessionStatusCode` | An enum of reasons a session stopped (`OK`, `Left`, `MeetingEnded`, `AudioAttendeeRemoved`, ...). You get one of these back in the `audioVideoDidStop` observer and have to branch on it yourself — the SDK doesn't pre-classify "the meeting ended" vs. "you lost network" for you. |

### The types (`RosterEntry`, `AwsMeeting`, `AwsAttendee`, `ChimeConnectionState`)

```ts
export type RosterEntry = {
    attendeeId: string;
    name: string;
    isLocal: boolean;
    muted: boolean;
    speaking: boolean;
};

export type AwsMeeting = Record<string, unknown>;
export type AwsAttendee = { AttendeeId: string } & Record<string, unknown>;

export type ChimeConnectionState =
    'idle' | 'connecting' | 'connected' | 'left' | 'ended' | 'error';
```

None of these come from the SDK — the SDK's own types for a "meeting" or "attendee" are
untyped `any`-ish blobs (`MeetingSessionConfiguration`'s constructor literally accepts
`any`), because they're just AWS API JSON passed straight through. `RosterEntry` is *our*
shape, built by combining three separate pieces of information the SDK gives us
independently (presence tells us an attendee ID exists; our own backend tells us their name;
the volume indicator tells us mute/speaking state) — the SDK never hands you a "roster"
object, you assemble one yourself from these callbacks. `ChimeConnectionState` is our own
small state machine layered on top of the SDK's lower-level per-event callbacks, so the UI
(`meetings/show.tsx`) can `switch` on one value instead of tracking several booleans.

### Refs: `sessionRef`, `audioElementRef`, `nameCacheRef`

```ts
const sessionRef = useRef<DefaultMeetingSession | null>(null);
const audioElementRef = useRef<HTMLAudioElement | null>(null);
const nameCacheRef = useRef<Map<string, string>>(new Map());
```

`DefaultMeetingSession` is a stateful, non-serializable object with open network
connections — it can never go into React state (`useState`) because it's not something React
should re-render on or clone; it has to live in a `ref` that every callback closes over.
Same reasoning for the injected `<audio>` element (a real DOM node) and the name cache (a
`Map`, mutated in place rather than triggering re-renders on every cache hit — only actual
roster changes should re-render the UI).

### `resolveAttendeeName` — bridging Chime's anonymous IDs to real names

```ts
const resolveAttendeeName = useCallback(
    async (attendeeId: string): Promise<string> => {
        const cached = nameCacheRef.current.get(attendeeId);
        if (cached) return cached;

        try {
            const response = (await fetchAttendeeName(
                AttendeeController.show([meetingUuid, attendeeId]).url,
            )) as { name?: string };
            const name = response?.name ?? 'Guest';
            nameCacheRef.current.set(attendeeId, name);
            return name;
        } catch {
            return 'Guest';
        }
    },
    [fetchAttendeeName, meetingUuid],
);
```

Not an SDK call at all — this is the glue that covers the gap the SDK leaves open (see
[`AttendeeController`](#attendeecontroller)): Chime only ever gives you an opaque
`attendeeId` string, never a display name. `fetchAttendeeName` is Inertia v3's `useHttp`
hook's `get`, hitting our own `GET /meetings/{uuid}/attendees/{attendeeId}` endpoint. The
`Map` cache means each attendee's name is looked up from our backend exactly once per
session, no matter how many times their volume-indicator callback fires (which is often —
several times a second while they're talking).

### `leave` — tearing a session down

```ts
const leave = useCallback(async () => {
    const session = sessionRef.current;
    if (session) {
        session.audioVideo.stop();
        await session.destroy();
        sessionRef.current = null;
    }
    if (audioElementRef.current) {
        audioElementRef.current.remove();
        audioElementRef.current = null;
    }
    setRoster({});
}, []);
```

- **`session.audioVideo.stop()`** — closes the signaling connection and all WebRTC peer
  connections, stops sending/receiving audio. This alone is enough to leave the call from
  every other attendee's point of view (they'll get a `present: false` presence callback).
- **`session.destroy()`** — releases everything `stop()` didn't: internal event listeners,
  Web Audio nodes, timers. The SDK explicitly documents this as required cleanup beyond
  `stop()` — skipping it leaks memory/handles if the user joins and leaves several meetings
  in one page session (which, in a SPA like this, is exactly what happens on every
  navigation).
- Removing the `<audio>` element and clearing `sessionRef` prevent a stale session from being
  reused by a later `join()` call.
- This function is called from **two** places: the explicit "Leave" button
  (`show.tsx`'s `handleLeave`) and a `useEffect` cleanup (see below) that fires on unmount —
  so navigating away without clicking "Leave" still tears the session down correctly.

### `join` — the main event

This is the only function that actually opens a connection to AWS. Walking through it top to
bottom:

**1. Build the session object (no network activity yet):**
```ts
const logger = new ConsoleLogger('ChimeMeeting', LogLevel.WARN);
const deviceController = new DefaultDeviceController(logger, { enableWebAudio: true });
const configuration = new MeetingSessionConfiguration(
    { Meeting: awsMeeting },
    { Attendee: awsAttendee },
);
const session = new DefaultMeetingSession(configuration, logger, deviceController);
sessionRef.current = session;
```
`awsMeeting`/`awsAttendee` are the exact JSON objects `AttendeeController::store` returned —
this is the one contract point between backend and frontend that has to match AWS's own
response shape (we deliberately don't reshape them anywhere in between, precisely so this
constructor call keeps working unmodified). `MeetingSessionConfiguration` reads out of that
JSON: the signaling WebSocket URL, the media placement (which literal AWS media server to
connect to), the meeting ID, the attendee ID, and the secret join token — everything the SDK
needs to authenticate and route the connection, entirely without your app's backend being
involved again.

**2. Pick a microphone and start sending audio:**
```ts
const audioInputDevices = await session.audioVideo.listAudioInputDevices();
await session.audioVideo.startAudioInput(audioInputDevices[0]?.deviceId ?? null);
```
`listAudioInputDevices()` triggers the browser's device-enumeration + (if not already
granted) the microphone permission prompt. We don't build a picker UI — we just take
`[0]`, the browser's default microphone, falling back to `null` (a generated silent stream)
if literally no input device exists at all, so a machine with no mic can still join and
listen. `startAudioInput` is what actually opens the `getUserMedia` stream and hands it to
the device controller; nothing is sent to AWS yet, that only happens once `.start()` (step 5)
opens the peer connection.

**3. Play everyone else's audio:**
```ts
const audioElement = document.createElement('audio');
audioElement.style.display = 'none';
document.body.appendChild(audioElement);
audioElementRef.current = audioElement;
await session.audioVideo.bindAudioElement(audioElement);
```
The SDK doesn't manage its own output element for you — it needs a real `<audio>` DOM node
to attach the mixed remote audio stream to. We create one dynamically (hidden — there's
nothing to visually show for it) rather than putting one in JSX, since this needs to happen
exactly once per session and needs a ref back to it for cleanup in `leave()`. **Forget this
step and the call "works" (you show as connected, roster updates fine) but is completely
silent** — this is the single easiest piece to accidentally leave out when adapting this
code, and the bug it causes is invisible: no error, just no sound.

**4. Seed your own roster entry:**
```ts
setRoster({
    [awsAttendee.AttendeeId]: {
        attendeeId: awsAttendee.AttendeeId,
        name,
        isLocal: true,
        muted: false,
        speaking: false,
    },
});
```
Not strictly necessary — the presence subscription below will fire for you too, moments
later — but this makes your own tile appear on screen instantly rather than waiting a
network round trip, and lets us set `name` directly from what was typed in the Lobby instead
of round-tripping to `resolveAttendeeName` for ourselves.

**5. Subscribe to who's in the call — `realtimeSubscribeToAttendeeIdPresence`:**
```ts
session.audioVideo.realtimeSubscribeToAttendeeIdPresence((attendeeId, present) => {
    if (!present) {
        setRoster((prev) => { const next = { ...prev }; delete next[attendeeId]; return next; });
        return;
    }

    const isLocal = attendeeId === awsAttendee.AttendeeId;
    setRoster((prev) => ({
        ...prev,
        [attendeeId]: prev[attendeeId] ?? { attendeeId, name: isLocal ? name : '…', isLocal, muted: false, speaking: false },
    }));

    if (!isLocal) {
        resolveAttendeeName(attendeeId).then((resolvedName) => {
            setRoster((prev) => prev[attendeeId] ? { ...prev, [attendeeId]: { ...prev[attendeeId], name: resolvedName } } : prev);
        });
    }

    session.audioVideo.realtimeSubscribeToVolumeIndicator(attendeeId, (id, volume, muted) => {
        setRoster((prev) => prev[id] ? { ...prev, [id]: { ...prev[id], muted: muted ?? prev[id].muted, speaking: (volume ?? 0) > SPEAKING_VOLUME_THRESHOLD } } : prev);
    });
});
```
This single callback is doing three distinct jobs, worth separating mentally even though
they're one function:

- **Presence itself.** Chime calls this callback for *every* attendee currently in (or
  joining/leaving) the meeting, including yourself — that's why there's an `isLocal` check
  rather than filtering yourself out entirely. `present === false` means someone
  disconnected (they clicked Leave, closed the tab, lost network, or the owner ended the
  meeting for everyone) — we just delete them from the roster `Record`. `present === true`
  means a new attendee showed up; we insert a placeholder (`name: '…'`) immediately so the
  tile appears before we know who they are.
- **Name resolution**, kicked off only for non-local attendees (`if (!isLocal)`) — this is
  the call into `resolveAttendeeName` described above, which lands asynchronously and
  patches the placeholder `'…'` with the real name once our backend responds. There's a
  `prev[attendeeId] ?` guard in the `.then()` because by the time the name resolves, that
  attendee may have already left — without the guard you'd resurrect a roster entry for
  someone who's already gone.
- **Registering the volume subscription** (next bullet) — deliberately done *inside* the
  presence callback, once per attendee, rather than once globally, because
  `realtimeSubscribeToVolumeIndicator` requires a specific `attendeeId` to subscribe to; you
  can't ask for "everyone's volume" in one call.

**6. Subscribe to mute state + speaking — `realtimeSubscribeToVolumeIndicator`:**
```ts
session.audioVideo.realtimeSubscribeToVolumeIndicator(attendeeId, (id, volume, muted) => {
    setRoster((prev) => prev[id] ? {
        ...prev,
        [id]: { ...prev[id], muted: muted ?? prev[id].muted, speaking: (volume ?? 0) > SPEAKING_VOLUME_THRESHOLD },
    } : prev);
});
```
Fires continuously (many times a second) for each attendee while the meeting is active, with
`volume` as a `number | null` between 0–1 (`null` briefly during connection setup, before the
SDK has a reading yet — hence `volume ?? 0`, treating "no reading yet" as silent rather than
crashing on `null > threshold`) and `muted` as `boolean | null`. `SPEAKING_VOLUME_THRESHOLD`
(`0.15`, defined at the top of the file) is our own arbitrary cutoff for "loud enough to
count as talking" — the SDK reports a continuous number, not a boolean "is speaking," so we
have to pick that threshold ourselves. This is also the piece that drives the glowing ring on
`ParticipantTile` — nothing about it is Chime-specific rendering, it's just a `boolean` prop
by the time it reaches that component.

**7. Detect the session ending — `addObserver` / `audioVideoDidStop`:**
```ts
session.audioVideo.addObserver({
    audioVideoDidStop: (sessionStatus) => {
        const code = sessionStatus.statusCode();
        if (code === MeetingSessionStatusCode.MeetingEnded
            || code === MeetingSessionStatusCode.AudioAttendeeRemoved
            || code === MeetingSessionStatusCode.TURNCredentialsForbidden) {
            setConnectionState('ended');
        } else if (code === MeetingSessionStatusCode.Left) {
            setConnectionState('left');
        } else if (code !== MeetingSessionStatusCode.OK) {
            setConnectionState('error');
        }
    },
});
```
`AudioVideoObserver` is the SDK's general-purpose event interface — it has other hooks too
(`audioVideoDidStart`, `videoTileDidUpdate`, connection-health callbacks, etc.) but
`audioVideoDidStop` is the only one this audio-only app needs: it's called exactly once,
whenever the session stops for *any* reason, and hands you a `MeetingSessionStatus` you
interrogate via `.statusCode()`. We only branch on the codes that matter for this app's UX:
  - `MeetingEnded` — the case that matters most: this is how a guest's browser finds out the
    **owner ended the meeting** (`DELETE /meetings/{uuid}` → AWS `DeleteMeeting` → AWS itself
    forcibly disconnects every attendee with this status code). No message from our own
    backend is involved — Chime's own teardown carries the information.
  - `AudioAttendeeRemoved` / `TURNCredentialsForbidden` — both effectively mean "you're no
    longer welcome in this meeting" (e.g. the meeting was deleted between you loading the
    page and actually connecting) — treated the same as `MeetingEnded` for UI purposes.
  - `Left` — the *expected* code when **you** called `audioVideo.stop()` yourself (via our
    own `leave()`) — shown as "You left the meeting" rather than "This meeting has ended."
  - Anything else non-`OK` (network failure, signaling error, etc.) falls through to a
    generic `'error'` state.

**8. Actually connect:**
```ts
session.audioVideo.start();
setConnectionState('connected');
```
Everything above this line was setup — `.start()` is the call that opens the real WebSocket
signaling connection and WebRTC peer connection to AWS's media servers and begins
sending/receiving audio. It's synchronous from the caller's point of view (fire-and-forget;
connection progress is reported asynchronously through the observer registered in step 7,
via `audioVideoDidStart`/`audioVideoDidStartConnecting` if you were listening for them — this
app doesn't, it optimistically flips to `'connected'` immediately since the whole flow up to
here already required the mic and signaling info to be valid).

**9. Anything throws → generic error, logged:**
```ts
} catch (error) {
    console.error('[ChimeMeeting] failed to join', error);
    setConnectionState('error');
}
```
Wraps the entire sequence above. Realistic failure causes: microphone permission denied,
`getUserMedia` unavailable (non-secure context — see [Gotchas](#gotchas-we-hit-and-fixed)),
malformed `awsMeeting`/`awsAttendee` JSON, or a browser missing WebRTC support entirely. The
`console.error` matters more than it looks — an earlier version of this code had a bare
`catch { setConnectionState('error') }` with no logging, which produced a UI that correctly
said "something went wrong" but gave zero information for debugging *why*. Always log the
real error before collapsing it into a generic user-facing state.

### `toggleMute` — local-only, no network round trip

```ts
const toggleMute = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;

    if (session.audioVideo.realtimeIsLocalAudioMuted()) {
        session.audioVideo.realtimeUnmuteLocalAudio();
        setIsMuted(false);
    } else {
        session.audioVideo.realtimeMuteLocalAudio();
        setIsMuted(true);
    }
}, []);
```
All three of these (`realtimeIsLocalAudioMuted`, `realtimeMuteLocalAudio`,
`realtimeUnmuteLocalAudio`) are synchronous, local SDK state — muting stops your outbound
audio track from being sent, instantly, without asking AWS anything. Other attendees find
out you're muted through *their* volume-indicator subscription (the `muted` field from step
6 above) — there's no separate "broadcast my mute state" call, it's implied by the
signaling layer.

### Cleanup on unmount

```ts
useEffect(() => {
    return () => {
        void leave();
    };
}, [leave]);
```
A safety net independent of the "Leave" button: if the user navigates away, closes the tab,
or the component unmounts for any other reason, this fires and tears the session down the
same way `handleLeave` does. `void` because `leave()` is `async` but a `useEffect` cleanup
function can't itself be async — we intentionally don't await it (nothing left to do with the
result once the component's gone).

### What's *not* Chime: the Lobby's mic preview

`resources/js/components/meeting/lobby.tsx` shows a live microphone level meter **before**
you've joined — deliberately built with plain browser APIs, not the SDK, because there's no
`DefaultMeetingSession` to use yet (that only gets constructed once you have a `Meeting`
+ `Attendee` pair, which only exists after clicking "Join now"):
```ts
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const audioContext = new AudioContext();
const source = audioContext.createMediaStreamSource(stream);
const analyser = audioContext.createAnalyser();
source.connect(analyser);
// ...requestAnimationFrame loop reading analyser.getByteFrequencyData()...
```
This stream is explicitly stopped (`stream.getTracks().forEach(t => t.stop())`) the moment
"Join now" is clicked, *before* handing off to `useChimeMeeting.join()` — which then opens
its own, independent `getUserMedia` call via `startAudioInput`. The two never share a stream;
the Lobby's is purely cosmetic (so you can see your mic is working and pre-mute if you want),
and gets thrown away once the real session takes over.

### How the page ties it all together

`resources/js/pages/meetings/show.tsx` never imports anything from `amazon-chime-sdk-js`
directly — it only calls `useChimeMeeting(meeting.uuid)` and reads back
`{ connectionState, isMuted, roster, join, leave, toggleMute }`, rendering `<Lobby>`,
a connecting spinner, `<CallRoom>`, or an "ended/left" screen purely by switching on
`connectionState`. `chime.join` is passed straight through as the `Lobby`'s `onJoin` prop —
the Lobby doesn't know or care that it's a Chime session being opened, it just knows "call
this function with a name and two JSON blobs once the join request succeeds." That's the
whole point of keeping every SDK call inside the one hook: the rest of the UI is testable
and reasonable about without ever touching WebRTC concepts.
