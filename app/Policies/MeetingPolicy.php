<?php

namespace App\Policies;

use App\Models\Meeting;
use App\Models\User;

class MeetingPolicy
{
    /**
     * Determine whether the user can end the meeting for everyone.
     */
    public function end(User $user, Meeting $meeting): bool
    {
        return $user->id === $meeting->owner_id;
    }
}
