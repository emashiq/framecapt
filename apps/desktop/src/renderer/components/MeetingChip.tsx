import { Users } from 'lucide-react';
import type { MeetingListItem } from '../../shared/meeting-ipc';
import { useMeetings } from '../meeting/use-meetings';
import { notify } from '../lib/notify';
import { Button } from './ui/Button';

/**
 * "Zoom meeting detected · Record": one row per meeting main is watching. While a recording is
 * live the action adds the meeting's window to it instead of starting another recording.
 */
export function MeetingChip({ recordingLive }: { recordingLive: boolean }) {
  const meetings = useMeetings();
  if (meetings.length === 0) return null;

  async function act(meeting: MeetingListItem): Promise<void> {
    const result = recordingLive
      ? await window.framecapt.invoke('meeting:addToRecording', { meetingId: meeting.meetingId })
      : await window.framecapt.invoke('meeting:record', {
          meetingId: meeting.meetingId,
          withScreen: false,
        });
    if (!result.ok) notify.error(result.error);
  }

  return (
    <ul className="mb-4 flex flex-col gap-2" aria-label="Meetings" data-testid="meeting-chips">
      {meetings.map((meeting) => (
        <li
          key={meeting.meetingId}
          data-testid="meeting-chip"
          data-app={meeting.app}
          className="flex items-center gap-3 rounded-lg border border-line bg-accent-soft px-3.5 py-1.5 text-[13px] text-fg"
        >
          <Users className="size-4 shrink-0 text-accent-fg" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{meeting.appLabel} meeting detected</span>
          <Button
            size="sm"
            variant="secondary"
            data-testid="meeting-chip-action"
            onClick={() => void act(meeting)}
          >
            {recordingLive ? 'Add to recording' : 'Record'}
          </Button>
        </li>
      ))}
    </ul>
  );
}
