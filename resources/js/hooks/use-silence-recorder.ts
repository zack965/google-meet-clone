import type { AudioVideoFacade } from 'amazon-chime-sdk-js';
import { useEffect, useRef } from 'react';

/** RMS below this value is treated as silence. */
const SILENCE_RMS_THRESHOLD = 0.02;

/** How long the signal must stay below the threshold before we cut a segment. */
const SILENCE_DEBOUNCE_MS = 700;

/** Segments never cover more than the last minute of audio. */
const MAX_SEGMENT_MS = 60_000;

/** MediaRecorder flush interval; smaller values keep the rolling buffer fine-grained. */
const RECORDER_TIMESLICE_MS = 250;

type TimedChunk = {
    blob: Blob;
    timestamp: number;
};

/**
 * Watches the full meeting audio (local mic + remote mix), keeps a rolling
 * buffer of the last minute, and calls `onSegment` with a Blob spanning
 * "last silence up to now" every time the meeting goes quiet.
 */
export function useSilenceRecorder(
    audioVideo: AudioVideoFacade | null,
    localAudioStream: MediaStream | null,
    onSegment: (blob: Blob) => void,
) {
    const onSegmentRef = useRef(onSegment);
    onSegmentRef.current = onSegment;

    useEffect(() => {
        if (!audioVideo || !localAudioStream) {
            return;
        }

        let cancelled = false;
        let audioContext: AudioContext | null = null;
        let workletNode: AudioWorkletNode | null = null;
        let mediaRecorder: MediaRecorder | null = null;

        const buffer: TimedChunk[] = [];
        let silenceStartedAt: number | null = null;
        let hasSpokenSinceLastSegment = false;

        const mixObserver = {
            meetingAudioStreamBecameActive: (stream: MediaStream) => {
                if (audioContext && !cancelled) {
                    audioContext
                        .createMediaStreamSource(stream)
                        .connect(destinationOrThrow());
                }
            },
            meetingAudioStreamBecameInactive: () => {},
        };

        let destination: MediaStreamAudioDestinationNode | null = null;
        const destinationOrThrow = () => {
            if (!destination) {
                throw new Error('Audio destination not ready');
            }

            return destination;
        };

        function cutSegment() {
            if (buffer.length === 0) {
                return;
            }

            const blob = new Blob(
                buffer.map((chunk) => chunk.blob),
                { type: 'audio/webm' },
            );
            buffer.length = 0;
            hasSpokenSinceLastSegment = false;
            onSegmentRef.current(blob);
        }

        async function setup() {
            audioContext = new AudioContext();
            await audioContext.audioWorklet.addModule(
                '/worklets/rms-processor.js',
            );

            if (cancelled || !audioContext) {
                return;
            }

            destination = audioContext.createMediaStreamDestination();
            audioContext
                .createMediaStreamSource(localAudioStream!)
                .connect(destination);

            const remoteStream =
                await audioVideo!.getCurrentMeetingAudioStream();

            if (remoteStream) {
                audioContext
                    .createMediaStreamSource(remoteStream)
                    .connect(destination);
            }

            audioVideo!.addAudioMixObserver(mixObserver);

            workletNode = new AudioWorkletNode(audioContext, 'rms-processor');
            audioContext
                .createMediaStreamSource(destination.stream)
                .connect(workletNode);

            workletNode.port.onmessage = (event: MessageEvent<{ rms: number }>) => {
                const now = Date.now();
                const isSilent = event.data.rms < SILENCE_RMS_THRESHOLD;

                while (
                    buffer.length &&
                    now - buffer[0].timestamp > MAX_SEGMENT_MS
                ) {
                    buffer.shift();
                }

                if (isSilent) {
                    if (silenceStartedAt === null) {
                        silenceStartedAt = now;
                    } else if (
                        hasSpokenSinceLastSegment &&
                        now - silenceStartedAt >= SILENCE_DEBOUNCE_MS
                    ) {
                        cutSegment();
                    }
                } else {
                    silenceStartedAt = null;
                    hasSpokenSinceLastSegment = true;
                }
            };

            if (cancelled || !destination) {
                return;
            }

            mediaRecorder = new MediaRecorder(destination.stream, {
                mimeType: 'audio/webm;codecs=opus',
            });
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    buffer.push({ blob: event.data, timestamp: Date.now() });
                }
            };
            mediaRecorder.start(RECORDER_TIMESLICE_MS);
        }

        void setup();

        return () => {
            cancelled = true;
            mediaRecorder?.stop();
            audioVideo.removeAudioMixObserver(mixObserver);
            workletNode?.port.close();
            workletNode?.disconnect();
            void audioContext?.close();
        };
    }, [audioVideo, localAudioStream]);
}
