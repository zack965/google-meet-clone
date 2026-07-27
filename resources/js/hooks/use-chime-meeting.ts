import { useHttp } from '@inertiajs/react';
import {
    ConsoleLogger,
    DefaultDeviceController,
    DefaultMeetingSession,
    LogLevel,
    MeetingSessionStatusCode,
    MeetingSessionConfiguration,
} from 'amazon-chime-sdk-js';
import { useCallback, useEffect, useRef, useState } from 'react';
import AttendeeController from '@/actions/App/Http/Controllers/AttendeeController';

export type RosterEntry = {
    attendeeId: string;
    name: string;
    isLocal: boolean;
    muted: boolean;
    speaking: boolean;
};

export type AwsMeeting = Record<string, unknown>;
export type AwsAttendee = { AttendeeId: string } & Record<string, unknown>;

export type ChimeConnectionState =
    'idle' | 'connecting' | 'connected' | 'left' | 'ended' | 'error';

const SPEAKING_VOLUME_THRESHOLD = 0.15;

export function useChimeMeeting(meetingUuid: string) {
    const [connectionState, setConnectionState] =
        useState<ChimeConnectionState>('idle');
    const [isMuted, setIsMuted] = useState(false);
    const [roster, setRoster] = useState<Record<string, RosterEntry>>({});

    const sessionRef = useRef<DefaultMeetingSession | null>(null);
    const audioElementRef = useRef<HTMLAudioElement | null>(null);
    const nameCacheRef = useRef<Map<string, string>>(new Map());

    const { get: fetchAttendeeName } = useHttp({});

    const resolveAttendeeName = useCallback(
        async (attendeeId: string): Promise<string> => {
            const cached = nameCacheRef.current.get(attendeeId);

            if (cached) {
                return cached;
            }

            try {
                const response = (await fetchAttendeeName(
                    AttendeeController.show([meetingUuid, attendeeId]).url,
                )) as { name?: string };
                const name = response?.name ?? 'Guest';
                nameCacheRef.current.set(attendeeId, name);

                return name;
            } catch {
                return 'Guest';
            }
        },
        [fetchAttendeeName, meetingUuid],
    );

    const leave = useCallback(async () => {
        const session = sessionRef.current;

        if (session) {
            session.audioVideo.stop();
            await session.destroy();
            sessionRef.current = null;
        }

        if (audioElementRef.current) {
            audioElementRef.current.remove();
            audioElementRef.current = null;
        }

        setRoster({});
    }, []);

    const join = useCallback(
        async (
            name: string,
            awsMeeting: AwsMeeting,
            awsAttendee: AwsAttendee,
        ) => {
            setConnectionState('connecting');
            nameCacheRef.current.set(awsAttendee.AttendeeId, name);

            try {
                const logger = new ConsoleLogger('ChimeMeeting', LogLevel.WARN);
                const deviceController = new DefaultDeviceController(logger, {
                    enableWebAudio: true,
                });
                const configuration = new MeetingSessionConfiguration(
                    { Meeting: awsMeeting },
                    { Attendee: awsAttendee },
                );
                const session = new DefaultMeetingSession(
                    configuration,
                    logger,
                    deviceController,
                );
                sessionRef.current = session;

                const audioInputDevices =
                    await session.audioVideo.listAudioInputDevices();
                await session.audioVideo.startAudioInput(
                    audioInputDevices[0]?.deviceId ?? null,
                );

                const audioElement = document.createElement('audio');
                audioElement.style.display = 'none';
                document.body.appendChild(audioElement);
                audioElementRef.current = audioElement;
                await session.audioVideo.bindAudioElement(audioElement);

                setRoster({
                    [awsAttendee.AttendeeId]: {
                        attendeeId: awsAttendee.AttendeeId,
                        name,
                        isLocal: true,
                        muted: false,
                        speaking: false,
                    },
                });

                session.audioVideo.realtimeSubscribeToAttendeeIdPresence(
                    (attendeeId, present) => {
                        if (!present) {
                            setRoster((prev) => {
                                const next = { ...prev };
                                delete next[attendeeId];

                                return next;
                            });

                            return;
                        }

                        const isLocal = attendeeId === awsAttendee.AttendeeId;

                        setRoster((prev) => ({
                            ...prev,
                            [attendeeId]: prev[attendeeId] ?? {
                                attendeeId,
                                name: isLocal ? name : '…',
                                isLocal,
                                muted: false,
                                speaking: false,
                            },
                        }));

                        if (!isLocal) {
                            resolveAttendeeName(attendeeId).then(
                                (resolvedName) => {
                                    setRoster((prev) =>
                                        prev[attendeeId]
                                            ? {
                                                  ...prev,
                                                  [attendeeId]: {
                                                      ...prev[attendeeId],
                                                      name: resolvedName,
                                                  },
                                              }
                                            : prev,
                                    );
                                },
                            );
                        }

                        session.audioVideo.realtimeSubscribeToVolumeIndicator(
                            attendeeId,
                            (id, volume, muted) => {
                                setRoster((prev) =>
                                    prev[id]
                                        ? {
                                              ...prev,
                                              [id]: {
                                                  ...prev[id],
                                                  muted:
                                                      muted ?? prev[id].muted,
                                                  speaking:
                                                      (volume ?? 0) >
                                                      SPEAKING_VOLUME_THRESHOLD,
                                              },
                                          }
                                        : prev,
                                );
                            },
                        );
                    },
                );

                session.audioVideo.addObserver({
                    audioVideoDidStop: (sessionStatus) => {
                        const code = sessionStatus.statusCode();

                        if (
                            code === MeetingSessionStatusCode.MeetingEnded ||
                            code ===
                                MeetingSessionStatusCode.AudioAttendeeRemoved ||
                            code ===
                                MeetingSessionStatusCode.TURNCredentialsForbidden
                        ) {
                            setConnectionState('ended');
                        } else if (code === MeetingSessionStatusCode.Left) {
                            setConnectionState('left');
                        } else if (code !== MeetingSessionStatusCode.OK) {
                            setConnectionState('error');
                        }
                    },
                });

                session.audioVideo.start();
                setConnectionState('connected');
            } catch (error) {
                console.error('[ChimeMeeting] failed to join', error);
                setConnectionState('error');
            }
        },
        [resolveAttendeeName],
    );

    const toggleMute = useCallback(() => {
        const session = sessionRef.current;

        if (!session) {
            return;
        }

        if (session.audioVideo.realtimeIsLocalAudioMuted()) {
            session.audioVideo.realtimeUnmuteLocalAudio();
            setIsMuted(false);
        } else {
            session.audioVideo.realtimeMuteLocalAudio();
            setIsMuted(true);
        }
    }, []);

    useEffect(() => {
        return () => {
            void leave();
        };
    }, [leave]);

    return {
        connectionState,
        isMuted,
        roster: Object.values(roster),
        join,
        leave,
        toggleMute,
    };
}
