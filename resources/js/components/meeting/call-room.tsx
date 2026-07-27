import Controls from '@/components/meeting/controls';
import ParticipantTile from '@/components/meeting/participant-tile';
import type { RosterEntry } from '@/hooks/use-chime-meeting';

type Props = {
    meetingTitle: string | null;
    roster: RosterEntry[];
    isMuted: boolean;
    isOwner: boolean;
    onToggleMute: () => void;
    onLeave: () => void;
    onEndMeeting: () => void;
};

export default function CallRoom({
    meetingTitle,
    roster,
    isMuted,
    isOwner,
    onToggleMute,
    onLeave,
    onEndMeeting,
}: Props) {
    return (
        <div className="flex min-h-screen flex-col bg-muted/30">
            <header className="border-b border-sidebar-border/70 p-4 dark:border-sidebar-border">
                <h1 className="text-lg font-semibold">
                    {meetingTitle ?? 'Meeting'}
                </h1>
                <p className="text-sm text-muted-foreground">
                    {roster.length} participant{roster.length === 1 ? '' : 's'}
                </p>
            </header>

            <div className="grid flex-1 auto-rows-min grid-cols-2 gap-4 p-6 sm:grid-cols-3 lg:grid-cols-4">
                {roster.map((participant) => (
                    <ParticipantTile
                        key={participant.attendeeId}
                        participant={participant}
                    />
                ))}
            </div>

            <Controls
                isMuted={isMuted}
                isOwner={isOwner}
                onToggleMute={onToggleMute}
                onLeave={onLeave}
                onEndMeeting={onEndMeeting}
            />
        </div>
    );
}
