import { describe, expect, it } from 'vitest';
import { meetingBanner } from '../../src/shared/meeting-banner';
import type { SessionMeeting } from '../../src/shared/recorder-ipc';

const meeting = (overrides: Partial<SessionMeeting> = {}): SessionMeeting => ({
  app: 'zoom',
  appLabel: 'Zoom',
  state: 'visible',
  sharing: false,
  banner: null,
  ...overrides,
});

describe('meetingBanner', () => {
  it('shows nothing for a recording without a meeting or a quiet meeting', () => {
    expect(meetingBanner(null)).toBeNull();
    expect(meetingBanner(meeting())).toBeNull();
    expect(meetingBanner(meeting({ sharing: true }))).toBeNull();
  });

  it('a hidden window says to bring it to the front and that the audio is still recording', () => {
    expect(meetingBanner(meeting({ state: 'hidden' }))).toEqual({
      kind: 'meeting-hidden',
      text: 'Zoom window is hidden — bring it to the front to keep capturing. Audio is still recording.',
    });
  });

  it('an ended meeting says so', () => {
    expect(meetingBanner(meeting({ state: 'ended' }))).toEqual({
      kind: 'meeting-ended',
      text: 'Meeting ended',
    });
  });

  it('asks about a shared screen, or says it is already in the recording', () => {
    expect(meetingBanner(meeting({ banner: 'share-ask' }))?.kind).toBe('share-ask');
    expect(meetingBanner(meeting({ banner: 'share-already' }))).toEqual({
      kind: 'share-already',
      text: 'Your shared screen is already in the recording',
    });
  });

  it('what needs the user first wins: ended, then hidden, then the share', () => {
    expect(meetingBanner(meeting({ state: 'ended', banner: 'share-ask' }))?.kind).toBe(
      'meeting-ended',
    );
    expect(meetingBanner(meeting({ state: 'hidden', banner: 'share-ask' }))?.kind).toBe(
      'meeting-hidden',
    );
  });
});
