<?php

namespace App\Models;

use Database\Factories\MeetingFactory;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Meeting extends Model
{
    /** @use HasFactory<MeetingFactory> */
    use HasFactory, HasUuids;

    protected $fillable = [
        'owner_id',
        'title',
        'uuid',
        'aws_meeting_id',
        'aws_meeting',
        'ended_at',
    ];

    protected $casts = [
        'aws_meeting' => 'array',
        'ended_at' => 'datetime',
    ];

    /**
     * Use UUID for route model binding.
     */
    public function getRouteKeyName(): string
    {
        return 'uuid';
    }

    /**
     * Only the `uuid` column is UUID-generated; `id` stays an auto-incrementing integer.
     *
     * @return array<int, string>
     */
    public function uniqueIds(): array
    {
        return ['uuid'];
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function owner(): BelongsTo
    {
        return $this->belongsTo(User::class, 'owner_id');
    }

    /**
     * @return HasMany<Attendee, $this>
     */
    public function attendees(): HasMany
    {
        return $this->hasMany(Attendee::class);
    }

    public function isEnded(): bool
    {
        return $this->ended_at !== null;
    }
}
