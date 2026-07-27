<?php

namespace Database\Factories;

use App\Models\Meeting;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<Meeting>
 */
class MeetingFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $awsMeetingId = (string) Str::uuid();

        return [
            'owner_id' => User::factory(),
            'title' => fake()->sentence(3),
            'aws_meeting_id' => $awsMeetingId,
            'aws_meeting' => [
                'MeetingId' => $awsMeetingId,
                'ExternalMeetingId' => (string) Str::uuid(),
                'MediaPlacement' => [
                    'AudioHostUrl' => 'wss://example.com/audio',
                ],
            ],
            'ended_at' => null,
        ];
    }

    public function ended(): static
    {
        return $this->state(fn (): array => [
            'ended_at' => now(),
        ]);
    }
}
