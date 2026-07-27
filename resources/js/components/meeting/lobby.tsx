import { useHttp } from '@inertiajs/react';
import { Mic, MicOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import AttendeeController from '@/actions/App/Http/Controllers/AttendeeController';
import AlertError from '@/components/alert-error';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import type { AwsAttendee, AwsMeeting } from '@/hooks/use-chime-meeting';

type JoinResponse = {
    meeting: AwsMeeting;
    attendee: AwsAttendee;
};

type Props = {
    meetingUuid: string;
    meetingTitle: string | null;
    authenticatedName: string | null;
    onJoin: (name: string, meeting: AwsMeeting, attendee: AwsAttendee) => void;
};

export default function Lobby({
    meetingUuid,
    meetingTitle,
    authenticatedName,
    onJoin,
}: Props) {
    const { data, setData, post, processing, errors } = useHttp({
        name: authenticatedName ?? '',
    });

    const [micLevel, setMicLevel] = useState(0);
    const [micMuted, setMicMuted] = useState(false);
    const [micError, setMicError] = useState<string | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    useEffect(() => {
        let audioContext: AudioContext | null = null;
        let frame = 0;

        navigator.mediaDevices
            .getUserMedia({ audio: true })
            .then((stream) => {
                streamRef.current = stream;
                audioContext = new AudioContext();
                const source = audioContext.createMediaStreamSource(stream);
                const analyser = audioContext.createAnalyser();
                analyser.fftSize = 512;
                source.connect(analyser);
                const levels = new Uint8Array(analyser.frequencyBinCount);

                const tick = () => {
                    analyser.getByteFrequencyData(levels);
                    const average =
                        levels.reduce((sum, value) => sum + value, 0) /
                        levels.length;
                    setMicLevel(Math.min(1, average / 80));
                    frame = requestAnimationFrame(tick);
                };
                tick();
            })
            .catch(() =>
                setMicError(
                    'Microphone access was denied. Allow access to join with audio.',
                ),
            );

        return () => {
            cancelAnimationFrame(frame);
            streamRef.current?.getTracks().forEach((track) => track.stop());
            void audioContext?.close();
        };
    }, []);

    useEffect(() => {
        streamRef.current?.getAudioTracks().forEach((track) => {
            track.enabled = !micMuted;
        });
    }, [micMuted]);

    const canJoin = authenticatedName ? true : data.name.trim().length > 0;

    const handleJoin = async () => {
        streamRef.current?.getTracks().forEach((track) => track.stop());

        const response = (await post(
            AttendeeController.store(meetingUuid).url,
        )) as JoinResponse;

        onJoin(
            (authenticatedName ?? data.name).trim(),
            response.meeting,
            response.attendee,
        );
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle>{meetingTitle ?? 'Join meeting'}</CardTitle>
                    <CardDescription>
                        Check your mic, then join when you&apos;re ready.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="flex items-center justify-center gap-3 rounded-lg border border-sidebar-border/70 p-4 dark:border-sidebar-border">
                        <Button
                            type="button"
                            variant={micMuted ? 'secondary' : 'outline'}
                            size="icon"
                            onClick={() => setMicMuted((prev) => !prev)}
                        >
                            {micMuted ? (
                                <MicOff className="size-4" />
                            ) : (
                                <Mic className="size-4" />
                            )}
                        </Button>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                                className="h-full bg-primary transition-[width] duration-75"
                                style={{
                                    width: `${micMuted ? 0 : micLevel * 100}%`,
                                }}
                            />
                        </div>
                    </div>

                    {micError && <AlertError errors={[micError]} />}

                    {!authenticatedName && (
                        <div className="grid gap-2">
                            <Label htmlFor="name">Your name</Label>
                            <Input
                                id="name"
                                autoFocus
                                value={data.name}
                                onChange={(e) =>
                                    setData('name', e.target.value)
                                }
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && canJoin) {
                                        void handleJoin();
                                    }
                                }}
                                placeholder="Enter your name"
                            />
                            {errors.name && (
                                <AlertError errors={[errors.name]} />
                            )}
                        </div>
                    )}

                    <Button
                        className="w-full"
                        size="lg"
                        disabled={!canJoin || processing}
                        onClick={handleJoin}
                    >
                        {processing ? <Spinner /> : 'Join now'}
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
