<?php

use App\Models\Attendee;
use App\Models\Meeting;
use App\Models\User;
use Aws\Result;

test('guests can join a meeting by providing their name', function () {
    $meeting = Meeting::factory()->create();

    mockChimeClient()
        ->shouldReceive('createAttendee')
        ->once()
        ->with(Mockery::on(fn (array $args): bool => $args['MeetingId'] === $meeting->aws_meeting_id
            && is_string($args['ExternalUserId'])))
        ->andReturn(new Result([
            'Attendee' => [
                'AttendeeId' => 'aws-attendee-id',
                'JoinToken' => 'token',
            ],
        ]));

    $response = $this->postJson(route('meetings.attendees.store', $meeting), [
        'name' => 'Guest User',
    ]);

    $response->assertOk()->assertJsonStructure(['meeting', 'attendee']);

    $attendee = Attendee::sole();
    expect($attendee->name)->toBe('Guest User');
    expect($attendee->user_id)->toBeNull();
    expect($attendee->aws_attendee_id)->toBe('aws-attendee-id');
});

test('guests must provide a name to join', function () {
    $meeting = Meeting::factory()->create();

    $response = $this->postJson(route('meetings.attendees.store', $meeting), []);

    $response->assertUnprocessable()->assertJsonValidationErrors('name');
});

test('authenticated users can join without providing a name', function () {
    $user = User::factory()->create(['name' => 'Jane Doe']);
    $meeting = Meeting::factory()->create();

    mockChimeClient()
        ->shouldReceive('createAttendee')
        ->once()
        ->andReturn(new Result([
            'Attendee' => ['AttendeeId' => 'aws-attendee-id'],
        ]));

    $response = $this->actingAs($user)->postJson(route('meetings.attendees.store', $meeting), []);

    $response->assertOk();

    $attendee = Attendee::sole();
    expect($attendee->name)->toBe('Jane Doe');
    expect($attendee->user_id)->toBe($user->id);
});

test('nobody can join an ended meeting', function () {
    $meeting = Meeting::factory()->ended()->create();

    $response = $this->postJson(route('meetings.attendees.store', $meeting), [
        'name' => 'Guest User',
    ]);

    $response->assertStatus(410);
});

test('an attendee name can be resolved by their aws attendee id', function () {
    $meeting = Meeting::factory()->create();
    $attendee = Attendee::factory()->for($meeting)->create(['name' => 'Alex']);

    $response = $this->getJson(route('meetings.attendees.show', [
        $meeting,
        $attendee->aws_attendee_id,
    ]));

    $response->assertOk()->assertJson(['name' => 'Alex']);
});
