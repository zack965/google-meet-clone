import { Form, Head, Link, router } from '@inertiajs/react';
import { Copy, Video } from 'lucide-react';
import MeetingController from '@/actions/App/Http/Controllers/MeetingController';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useClipboard } from '@/hooks/use-clipboard';
import { dashboard } from '@/routes';

type Meeting = {
    uuid: string;
    title: string | null;
    ended_at: string | null;
    created_at: string;
};

export default function Dashboard({ meetings }: { meetings: Meeting[] }) {
    const [, copy] = useClipboard();

    return (
        <>
            <Head title="Dashboard" />
            <div className="flex h-full flex-1 flex-col gap-4 overflow-x-auto rounded-xl p-4">
                <Card>
                    <CardHeader>
                        <CardTitle>Start a new meeting</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <Form
                            {...MeetingController.store.form()}
                            options={{ preserveScroll: true }}
                        >
                            {({ processing }) => (
                                <Button type="submit" disabled={processing}>
                                    {processing ? (
                                        <Spinner />
                                    ) : (
                                        <Video className="size-4" />
                                    )}
                                    New meeting
                                </Button>
                            )}
                        </Form>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Your meetings</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {meetings.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                You haven&apos;t created any meetings yet.
                            </p>
                        ) : (
                            <ul className="divide-y divide-sidebar-border/70 dark:divide-sidebar-border">
                                {meetings.map((meeting) => {
                                    const isEnded = meeting.ended_at !== null;
                                    const url =
                                        window.location.origin +
                                        MeetingController.show(meeting.uuid)
                                            .url;

                                    return (
                                        <li
                                            key={meeting.uuid}
                                            className="flex items-center justify-between gap-4 py-3"
                                        >
                                            <div className="flex items-center gap-3">
                                                <span className="font-medium">
                                                    {meeting.title ??
                                                        'Untitled meeting'}
                                                </span>
                                                <Badge
                                                    variant={
                                                        isEnded
                                                            ? 'secondary'
                                                            : 'default'
                                                    }
                                                >
                                                    {isEnded
                                                        ? 'Ended'
                                                        : 'Active'}
                                                </Badge>
                                            </div>

                                            <div className="flex items-center gap-2">
                                                {!isEnded && (
                                                    <>
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            onClick={() =>
                                                                copy(url)
                                                            }
                                                        >
                                                            <Copy className="size-4" />
                                                            Copy link
                                                        </Button>
                                                        <Button
                                                            asChild
                                                            size="sm"
                                                        >
                                                            <Link
                                                                href={
                                                                    MeetingController.show(
                                                                        meeting.uuid,
                                                                    ).url
                                                                }
                                                            >
                                                                Join
                                                            </Link>
                                                        </Button>
                                                        <Button
                                                            variant="destructive"
                                                            size="sm"
                                                            onClick={() =>
                                                                router.delete(
                                                                    MeetingController.end(
                                                                        meeting.uuid,
                                                                    ).url,
                                                                    {
                                                                        preserveScroll: true,
                                                                    },
                                                                )
                                                            }
                                                        >
                                                            End
                                                        </Button>
                                                    </>
                                                )}
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </CardContent>
                </Card>
            </div>
        </>
    );
}

Dashboard.layout = {
    breadcrumbs: [
        {
            title: 'Dashboard',
            href: dashboard(),
        },
    ],
};
