<?php

namespace App\Http\Controllers;

use App\Models\Meeting;
use Aws\ChimeSDKMeetings\ChimeSDKMeetingsClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class AttendeeController extends Controller
{
    public function __construct(protected ChimeSDKMeetingsClient $client) {}

    /**
     * Join a meeting as an attendee (authenticated user or anonymous guest).
     */
    public function store(Request $request, Meeting $meeting): JsonResponse
    {
        abort_if($meeting->isEnded(), 410, 'This meeting has ended.');

        $validated = $request->validate([
            'name' => [Rule::requiredIf(! $request->user()), 'nullable', 'string', 'max:255'],
        ]);

        $name = $request->user()->name ?? $validated['name'];

        $result = $this->client->createAttendee([
            'MeetingId' => $meeting->aws_meeting_id,
            'ExternalUserId' => (string) Str::uuid(),
        ]);

        $awsAttendee = $result->get('Attendee');

        $meeting->attendees()->create([
            'user_id' => $request->user()?->id,
            'name' => $name,
            'aws_attendee_id' => $awsAttendee['AttendeeId'],
            'aws_attendee' => $awsAttendee,
        ]);

        return response()->json([
            'meeting' => $meeting->aws_meeting,
            'attendee' => $awsAttendee,
        ]);
    }

    /**
     * Resolve the display name for a given AWS attendee id, used by the
     * Chime SDK roster to render other participants' names.
     */
    public function show(Meeting $meeting, string $awsAttendeeId): JsonResponse
    {
        $attendee = $meeting->attendees()
            ->where('aws_attendee_id', $awsAttendeeId)
            ->firstOrFail();

        return response()->json([
            'name' => $attendee->name,
        ]);
    }
}
