<?php

namespace App\Http\Controllers;

use App\Models\Meeting;
use Aws\ChimeSDKMeetings\ChimeSDKMeetingsClient;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Str;
use Inertia\Inertia;
use Inertia\Response;

class MeetingController extends Controller
{
    public function __construct(protected ChimeSDKMeetingsClient $client) {}

    /**
     * Create a new meeting and redirect the owner straight into it.
     */
    public function store(Request $request): RedirectResponse
    {
        $validated = $request->validate([
            'title' => ['nullable', 'string', 'max:255'],
        ]);

        $result = $this->client->createMeeting([
            'ClientRequestToken' => (string) Str::uuid(),
            'ExternalMeetingId' => (string) Str::uuid(),
            'MediaRegion' => config('services.aws.region'),
        ]);

        $awsMeeting = $result->get('Meeting');

        $meeting = Meeting::create([
            'owner_id' => $request->user()->id,
            'title' => $validated['title'] ?? null,
            'aws_meeting_id' => $awsMeeting['MeetingId'],
            'aws_meeting' => $awsMeeting,
        ]);

        return to_route('meetings.show', $meeting);
    }

    /**
     * Show the public join/lobby/call page for a meeting.
     */
    public function show(Request $request, Meeting $meeting): Response
    {
        return Inertia::render('meetings/show', [
            'meeting' => [
                'uuid' => $meeting->uuid,
                'title' => $meeting->title,
                'isOwner' => $request->user()?->is($meeting->owner) ?? false,
                'isEnded' => $meeting->isEnded(),
            ],
        ]);
    }

    /**
     * End the meeting for every participant.
     */
    public function end(Meeting $meeting): RedirectResponse
    {
        Gate::authorize('end', $meeting);

        if (! $meeting->isEnded()) {
            $this->client->deleteMeeting([
                'MeetingId' => $meeting->aws_meeting_id,
            ]);

            $meeting->update(['ended_at' => now()]);
        }

        Inertia::flash('toast', ['type' => 'success', 'message' => __('Meeting ended.')]);

        return to_route('dashboard');
    }
}
