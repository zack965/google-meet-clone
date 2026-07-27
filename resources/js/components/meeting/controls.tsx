import { Copy, LogOut, Mic, MicOff, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useClipboard } from '@/hooks/use-clipboard';

type Props = {
    isMuted: boolean;
    isOwner: boolean;
    onToggleMute: () => void;
    onLeave: () => void;
    onEndMeeting: () => void;
};

export default function Controls({
    isMuted,
    isOwner,
    onToggleMute,
    onLeave,
    onEndMeeting,
}: Props) {
    const [, copy] = useClipboard();

    return (
        <div className="flex items-center justify-center gap-3 border-t border-sidebar-border/70 bg-background p-4 dark:border-sidebar-border">
            <Button
                variant={isMuted ? 'secondary' : 'outline'}
                size="lg"
                onClick={onToggleMute}
            >
                {isMuted ? (
                    <MicOff className="size-4" />
                ) : (
                    <Mic className="size-4" />
                )}
                {isMuted ? 'Unmute' : 'Mute'}
            </Button>

            <Button
                variant="outline"
                size="lg"
                onClick={() => copy(window.location.href)}
            >
                <Copy className="size-4" />
                Copy invite link
            </Button>

            <Button variant="outline" size="lg" onClick={onLeave}>
                <LogOut className="size-4" />
                Leave
            </Button>

            {isOwner && (
                <Button variant="destructive" size="lg" onClick={onEndMeeting}>
                    <PhoneOff className="size-4" />
                    End meeting
                </Button>
            )}
        </div>
    );
}
