import { z } from 'zod';
import { MEETING_APPS } from './meeting-signatures';

export const MeetingAppSchema = z.enum(MEETING_APPS);

/** Main -> the prompt window: a meeting was detected. */
export const MeetingPromptEventSchema = z.object({
  meetingId: z.string().min(1).max(64),
  app: MeetingAppSchema,
  appLabel: z.string().max(64),
  /** A recording is live: "Add to current recording" is offered (and is the primary button). */
  recordingLive: z.boolean(),
});
export type MeetingPromptEvent = z.infer<typeof MeetingPromptEventSchema>;

export const MEETING_PROMPT_ACTIONS = [
  'record',
  'record-with-screen',
  'add-to-recording',
  'dismiss',
  'mute-app',
] as const;
export type MeetingPromptAction = (typeof MEETING_PROMPT_ACTIONS)[number];

export const MeetingRespondRequestSchema = z.strictObject({
  meetingId: z.string().min(1).max(64),
  action: z.enum(MEETING_PROMPT_ACTIONS),
});
export type MeetingRespondRequest = z.infer<typeof MeetingRespondRequestSchema>;

/** One meeting being watched, for the main window. */
export const MeetingListItemSchema = z.object({
  meetingId: z.string().min(1).max(64),
  app: MeetingAppSchema,
  appLabel: z.string().max(64),
  sharing: z.boolean(),
});
export type MeetingListItem = z.infer<typeof MeetingListItemSchema>;

export const MeetingListSchema = z.object({ meetings: z.array(MeetingListItemSchema).max(16) });
export type MeetingList = z.infer<typeof MeetingListSchema>;
