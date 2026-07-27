import { MicOff } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import type { RosterEntry } from '@/hooks/use-chime-meeting';
import { useInitials } from '@/hooks/use-initials';
import { cn } from '@/lib/utils';

export default function ParticipantTile({
    participant,
}: {
    participant: RosterEntry;
}) {
    const getInitials = useInitials();

    return (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-sidebar-border/70 bg-card p-6 dark:border-sidebar-border">
            <Avatar
                className={cn(
                    'size-20 ring-2 ring-transparent transition-all',
                    participant.speaking && 'ring-primary',
                )}
            >
                <AvatarFallback className="text-lg font-medium">
                    {getInitials(participant.name)}
                </AvatarFallback>
            </Avatar>

            <div className="flex items-center gap-1.5 text-sm font-medium">
                <span className="max-w-40 truncate">
                    {participant.name}
                    {participant.isLocal && ' (You)'}
                </span>
                {participant.muted && (
                    <MicOff className="size-3.5 shrink-0 text-muted-foreground" />
                )}
            </div>
        </div>
    );
}
