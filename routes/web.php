<?php

use App\Http\Controllers\AttendeeController;
use App\Http\Controllers\DashboardController;
use App\Http\Controllers\MeetingController;
use Illuminate\Support\Facades\Route;

Route::inertia('/', 'welcome')->name('home');

Route::middleware(['auth', 'verified'])->group(function () {
    Route::get('dashboard', [DashboardController::class, 'index'])->name('dashboard');

    Route::post('meetings', [MeetingController::class, 'store'])->name('meetings.store');
    Route::delete('meetings/{meeting:uuid}', [MeetingController::class, 'end'])->name('meetings.end');
});

// Public join flow: anyone with the link can join as an anonymous guest.
Route::get('meetings/{meeting:uuid}', [MeetingController::class, 'show'])->name('meetings.show');
Route::post('meetings/{meeting:uuid}/attendees', [AttendeeController::class, 'store'])->name('meetings.attendees.store');
Route::get('meetings/{meeting:uuid}/attendees/{awsAttendeeId}', [AttendeeController::class, 'show'])->name('meetings.attendees.show');

require __DIR__ . '/settings.php';
