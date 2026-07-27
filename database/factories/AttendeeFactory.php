<?php

namespace Database\Factories;

use App\Models\Attendee;
use App\Models\Meeting;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<Attendee>
 */
class AttendeeFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $awsAttendeeId = (string) Str::uuid();

        return [
            'meeting_id' => Meeting::factory(),
            'user_id' => null,
            'name' => fake()->name(),
            'aws_attendee_id' => $awsAttendeeId,
            'aws_attendee' => [
                'AttendeeId' => $awsAttendeeId,
                'ExternalUserId' => (string) Str::uuid(),
                'JoinToken' => Str::random(40),
            ],
        ];
    }
}
