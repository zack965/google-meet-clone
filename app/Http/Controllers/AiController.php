<?php

namespace App\Http\Controllers;

use App\Models\Meeting;
use Aws\Polly\PollyClient;
use Aws\S3\S3Client;
use Aws\TranscribeService\TranscribeServiceClient;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

class AiController extends Controller
{
    /**
     * Maximum number of times to poll Transcribe before giving up.
     */
    private const int MAX_POLL_ATTEMPTS = 30;

    /**
     * Seconds to wait between each Transcribe job status poll.
     */
    private const int POLL_INTERVAL_SECONDS = 2;

    /**
     * Pause between transcription and synthesis when round-tripping a live
     * audio segment, per the AI voice pipeline design.
     */
    private const float SEGMENT_PROCESSING_DELAY_SECONDS = 0.5;

    public function __construct(
        protected S3Client $s3Client,
        protected TranscribeServiceClient $transcribeClient,
        protected PollyClient $pollyClient,
    ) {}

    /**
     * Transcribe an uploaded audio file to text using Amazon Transcribe.
     */
    public function audioToText(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'audio' => ['required', 'file', 'mimes:mp3,mp4,wav,flac,ogg,webm,amr', 'max:51200'],
        ]);

        $transcript = $this->transcribeAudio($validated['audio']);

        if ($transcript === null) {
            return response()->json(['message' => 'Transcription timed out.'], 504);
        }

        return response()->json(['transcript' => $transcript]);
    }

    /**
     * Synthesize speech from text using Amazon Polly and stream back the audio.
     */
    public function textToAudio(Request $request): Response
    {
        $validated = $request->validate([
            'text' => ['required', 'string', 'max:3000'],
            'voice_id' => ['nullable', 'string'],
        ]);

        return response($this->synthesizeSpeech($validated['text'], $validated['voice_id'] ?? null), 200, [
            'Content-Type' => 'audio/mpeg',
        ]);
    }

    /**
     * Round-trip a live meeting audio segment: transcribe it, pause briefly,
     * synthesize the resulting text back to speech, and stream the audio
     * straight back to the client so it can be played into the meeting.
     */
    public function processSegment(Request $request, Meeting $meeting, string $awsAttendeeId): Response
    {
        abort_if($meeting->isEnded(), 410, 'This meeting has ended.');

        $validated = $request->validate([
            'audio' => ['required', 'file', 'mimes:mp3,mp4,wav,flac,ogg,webm,amr', 'max:51200'],
        ]);

        $transcript = $this->transcribeAudio($validated['audio']);

        if ($transcript === null || trim($transcript) === '') {
            abort(504, 'Transcription timed out.');
        }

        usleep((int) (self::SEGMENT_PROCESSING_DELAY_SECONDS * 1_000_000));

        return response($this->synthesizeSpeech($transcript), 200, [
            'Content-Type' => 'audio/mpeg',
        ]);
    }

    /**
     * Upload a file to S3, run it through an Amazon Transcribe job, and
     * clean up the transient S3 objects once the job finishes.
     */
    private function transcribeAudio(UploadedFile $audio): ?string
    {
        $bucket = config('services.aws.bucket');
        $extension = $audio->extension() ?: $audio->getClientOriginalExtension();
        $key = 'transcribe-input/'.Str::uuid().'.'.$extension;
        $jobName = 'transcribe-'.Str::uuid();

        $this->s3Client->putObject([
            'Bucket' => $bucket,
            'Key' => $key,
            'Body' => fopen($audio->getRealPath(), 'rb'),
        ]);

        try {
            $this->transcribeClient->startTranscriptionJob([
                'TranscriptionJobName' => $jobName,
                'IdentifyLanguage' => true,
                'MediaFormat' => $extension,
                'Media' => [
                    'MediaFileUri' => "s3://{$bucket}/{$key}",
                ],
                'OutputBucketName' => $bucket,
                'OutputKey' => 'transcribe-output/',
            ]);

            for ($attempt = 0; $attempt < self::MAX_POLL_ATTEMPTS; $attempt++) {
                sleep(self::POLL_INTERVAL_SECONDS);

                $job = $this->transcribeClient->getTranscriptionJob([
                    'TranscriptionJobName' => $jobName,
                ])->get('TranscriptionJob');

                if ($job['TranscriptionJobStatus'] === 'COMPLETED') {
                    $transcriptUri = $job['Transcript']['TranscriptFileUri'];
                    $payload = Http::get($transcriptUri)->json();

                    return $payload['results']['transcripts'][0]['transcript'] ?? '';
                }

                if ($job['TranscriptionJobStatus'] === 'FAILED') {
                    abort(422, $job['FailureReason'] ?? 'Transcription job failed.');
                }
            }

            return null;
        } finally {
            $this->transcribeClient->deleteTranscriptionJob(['TranscriptionJobName' => $jobName]);
            $this->s3Client->deleteObject(['Bucket' => $bucket, 'Key' => $key]);
        }
    }

    /**
     * Synthesize speech from text using Amazon Polly, returning raw MP3 bytes.
     */
    private function synthesizeSpeech(string $text, ?string $voiceId = null): string
    {
        $result = $this->pollyClient->synthesizeSpeech([
            'Text' => $text,
            'OutputFormat' => 'mp3',
            'VoiceId' => $voiceId ?? 'Joanna',
            'Engine' => 'neural',
        ]);

        return $result['AudioStream']->getContents();
    }
}
