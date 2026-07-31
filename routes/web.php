<?php

use App\Http\Controllers\AiController;
use App\Http\Controllers\AttendeeController;
use App\Http\Controllers\DashboardController;
use App\Http\Controllers\MeetingController;
use Illuminate\Support\Facades\Route;

Route::inertia('/', 'welcome')->name('home');

Route::middleware(['auth', 'verified'])->group(function () {
    Route::get('dashboard', [DashboardController::class, 'index'])->name('dashboard');

    Route::post('meetings', [MeetingController::class, 'store'])->name('meetings.store');
    Route::delete('meetings/{meeting:uuid}', [MeetingController::class, 'end'])->name('meetings.end');

    Route::post('ai/audio-to-text', [AiController::class, 'audioToText'])->name('ai.audio-to-text');
    Route::post('ai/text-to-audio', [AiController::class, 'textToAudio'])->name('ai.text-to-audio');
});

// Public join flow: anyone with the link can join as an anonymous guest.
Route::get('meetings/{meeting:uuid}', [MeetingController::class, 'show'])->name('meetings.show');
Route::post('meetings/{meeting:uuid}/attendees', [AttendeeController::class, 'store'])->name('meetings.attendees.store');
Route::get('meetings/{meeting:uuid}/attendees/{awsAttendeeId}', [AttendeeController::class, 'show'])->name('meetings.attendees.show');
Route::post('meetings/{meeting:uuid}/attendees/{awsAttendeeId}/audio-segments', [AiController::class, 'processSegment'])->name('meetings.attendees.audio-segments.store');

require __DIR__.'/settings.php';
