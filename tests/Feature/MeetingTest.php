<?php

use App\Models\Meeting;
use App\Models\User;
use Aws\Result;

test('authenticated users can create a meeting', function () {
    $user = User::factory()->create();

    mockChimeClient()
        ->shouldReceive('createMeeting')
        ->once()
        ->andReturn(new Result([
            'Meeting' => [
                'MeetingId' => 'aws-meeting-id',
                'ExternalMeetingId' => 'external-id',
            ],
        ]));

    $response = $this->actingAs($user)->post(route('meetings.store'), [
        'title' => 'Standup',
    ]);

    $meeting = Meeting::sole();

    $response->assertRedirect(route('meetings.show', $meeting));
    expect($meeting->owner_id)->toBe($user->id);
    expect($meeting->title)->toBe('Standup');
    expect($meeting->aws_meeting_id)->toBe('aws-meeting-id');
    expect($meeting->uuid)->not->toBeNull();
});

test('guests cannot create a meeting', function () {
    $response = $this->post(route('meetings.store'), ['title' => 'Standup']);

    $response->assertRedirect(route('login'));
    expect(Meeting::count())->toBe(0);
});

test('the meeting join page is publicly accessible', function () {
    $meeting = Meeting::factory()->create();

    $response = $this->get(route('meetings.show', $meeting));

    $response->assertOk();
});

test('the meeting owner can end the meeting', function () {
    $owner = User::factory()->create();
    $meeting = Meeting::factory()->for($owner, 'owner')->create();

    mockChimeClient()
        ->shouldReceive('deleteMeeting')
        ->once()
        ->with(['MeetingId' => $meeting->aws_meeting_id])
        ->andReturn(new Result([]));

    $response = $this->actingAs($owner)->delete(route('meetings.end', $meeting));

    $response->assertRedirect(route('dashboard'));
    expect($meeting->refresh()->isEnded())->toBeTrue();
});

test('non-owners cannot end a meeting', function () {
    $owner = User::factory()->create();
    $otherUser = User::factory()->create();
    $meeting = Meeting::factory()->for($owner, 'owner')->create();

    $response = $this->actingAs($otherUser)->delete(route('meetings.end', $meeting));

    $response->assertForbidden();
    expect($meeting->refresh()->isEnded())->toBeFalse();
});
