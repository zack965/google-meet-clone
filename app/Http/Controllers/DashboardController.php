<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class DashboardController extends Controller
{
    public function index(Request $request): Response
    {
        $meetings = $request->user()->meetings()
            ->latest()
            ->get(['uuid', 'title', 'ended_at', 'created_at']);

        return Inertia::render('dashboard', [
            'meetings' => $meetings,
        ]);
    }
}
