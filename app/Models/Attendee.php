<?php

namespace App\Models;

use Database\Factories\AttendeeFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Attendee extends Model
{
    /** @use HasFactory<AttendeeFactory> */
    use HasFactory;

    protected $fillable = [
        'meeting_id',
        'user_id',
        'name',
        'aws_attendee_id',
        'aws_attendee',
    ];

    protected $casts = [
        'aws_attendee' => 'array',
    ];

    /**
     * @return BelongsTo<Meeting, $this>
     */
    public function meeting(): BelongsTo
    {
        return $this->belongsTo(Meeting::class);
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
