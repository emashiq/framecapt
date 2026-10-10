import type { SessionMeeting } from './recorder-ipc';

export type MeetingBannerKind = 'meeting-ended' | 'meeting-hidden' | 'share-ask' | 'share-already';

export interface MeetingBanner {
  kind: MeetingBannerKind;
  text: string;
}

/**
 * The row under the recording toolbar for a meeting recording, or null. What needs the user first
 * wins: a meeting that ended, a window that is hidden, then a question about a shared screen.
 */
export function meetingBanner(meeting: SessionMeeting | null): MeetingBanner | null {
  if (!meeting) return null;
  if (meeting.state === 'ended') return { kind: 'meeting-ended', text: 'Meeting ended' };
  if (meeting.state === 'hidden') {
    return {
      kind: 'meeting-hidden',
      text: `${meeting.appLabel} window is hidden — bring it to the front to keep capturing. Audio is still recording.`,
    };
  }
  if (meeting.banner === 'share-ask') {
    return {
      kind: 'share-ask',
      text: "You're sharing your screen — add it to the recording?",
    };
  }
  if (meeting.banner === 'share-already') {
    return { kind: 'share-already', text: 'Your shared screen is already in the recording' };
  }
  return null;
}
