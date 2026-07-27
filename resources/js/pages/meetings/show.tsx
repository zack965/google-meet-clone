import { Head, router, usePage } from '@inertiajs/react';
import MeetingController from '@/actions/App/Http/Controllers/MeetingController';
import CallRoom from '@/components/meeting/call-room';
import Lobby from '@/components/meeting/lobby';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useChimeMeeting } from '@/hooks/use-chime-meeting';
import { dashboard, home } from '@/routes';

type Props = {
    meeting: {
        uuid: string;
        title: string | null;
        isOwner: boolean;
        isEnded: boolean;
    };
};

export default function MeetingShow({ meeting }: Props) {
    const { auth } = usePage().props;
    const authenticatedName = auth.user ? auth.user.name : null;

    const chime = useChimeMeeting(meeting.uuid);

    const leaveTo = auth.user ? dashboard() : home();

    const handleLeave = async () => {
        await chime.leave();
        router.visit(leaveTo.url);
    };

    const handleEndMeeting = () => {
        router.delete(MeetingController.end(meeting.uuid).url);
    };

    if (meeting.isEnded || chime.connectionState === 'ended') {
        return (
            <>
                <Head title="Meeting ended" />
                <EndedScreen message="This meeting has ended." />
            </>
        );
    }

    if (chime.connectionState === 'left') {
        return (
            <>
                <Head title="You left the meeting" />
                <EndedScreen message="You left the meeting." />
            </>
        );
    }

    if (chime.connectionState === 'connected') {
        return (
            <>
                <Head title={meeting.title ?? 'Meeting'} />
                <CallRoom
                    meetingTitle={meeting.title}
                    roster={chime.roster}
                    isMuted={chime.isMuted}
                    isOwner={meeting.isOwner}
                    onToggleMute={chime.toggleMute}
                    onLeave={handleLeave}
                    onEndMeeting={handleEndMeeting}
                />
            </>
        );
    }

    return (
        <>
            <Head title={meeting.title ?? 'Join meeting'} />
            {chime.connectionState === 'connecting' ? (
                <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-muted/30">
                    <Spinner className="size-6" />
                    <p className="text-sm text-muted-foreground">
                        Joining the meeting…
                    </p>
                </div>
            ) : (
                <Lobby
                    meetingUuid={meeting.uuid}
                    meetingTitle={meeting.title}
                    authenticatedName={authenticatedName}
                    onJoin={chime.join}
                />
            )}
            {chime.connectionState === 'error' && (
                <div className="fixed inset-x-0 bottom-6 flex justify-center">
                    <p className="rounded-md bg-destructive px-4 py-2 text-sm text-white">
                        Something went wrong joining the meeting. Please try
                        again.
                    </p>
                </div>
            )}
        </>
    );
}

function EndedScreen({ message }: { message: string }) {
    const { auth } = usePage().props;
    const to = auth.user ? dashboard() : home();

    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-muted/30 text-center">
            <p className="text-lg font-medium">{message}</p>
            <Button asChild>
                <a href={to.url}>
                    {auth.user ? 'Back to dashboard' : 'Back home'}
                </a>
            </Button>
        </div>
    );
}
