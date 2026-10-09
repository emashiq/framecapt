import { BrowserWindow, screen } from 'electron';
import type { MeetingPromptEvent } from '../../shared/meeting-ipc';
import { sendEvent } from '../events';
import { loadRenderer, registerWebContents, securePreferences } from '../windows';
import type { MeetingPromptPort } from './service';

export const PROMPT_WIDTH = 360;
export const PROMPT_HEIGHT = 176;
const MARGIN = 16;

/**
 * The "record this meeting?" card: a small frameless window in the bottom right of the primary
 * display. It is shown without taking focus (the meeting keeps the keyboard), stays above full
 * screen windows like the recording toolbar, and is excluded from capture so it is never in a
 * recording. One at a time: a new meeting replaces the card; it closes by itself after the timeout.
 */
export class MeetingPromptWindow implements MeetingPromptPort {
  private win: BrowserWindow | undefined;
  private event: MeetingPromptEvent | null = null;
  private timer: NodeJS.Timeout | undefined;

  /** What the card shows now (the renderer asks for it when it has loaded). */
  current(): MeetingPromptEvent | null {
    return this.event;
  }

  show(event: MeetingPromptEvent, timeoutMs: number): void {
    this.close();
    this.event = event;
    const area = screen.getPrimaryDisplay().workArea;
    const x = area.x + area.width - PROMPT_WIDTH - MARGIN;
    const y = area.y + area.height - PROMPT_HEIGHT - MARGIN;
    const win = new BrowserWindow({
      title: 'FrameCapt meeting',
      x,
      y,
      width: PROMPT_WIDTH,
      height: PROMPT_HEIGHT,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: { ...securePreferences(), backgroundThrottling: false },
    });
    this.win = win;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setContentProtection(true);
    // Same quirk as the toolbar: place again after creation (mixed-DPI displays).
    win.setBounds({ x, y, width: PROMPT_WIDTH, height: PROMPT_HEIGHT });
    registerWebContents(win.webContents, 'meeting-prompt');
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      sendEvent(win.webContents, 'meeting:prompt', event);
      win.showInactive();
    });
    win.on('closed', () => {
      if (this.win === win) this.reset();
    });
    this.timer = setTimeout(() => this.close(event.meetingId), timeoutMs);
    void loadRenderer(win, 'meeting-prompt');
  }

  close(meetingId?: string): void {
    if (meetingId !== undefined && this.event?.meetingId !== meetingId) return;
    const win = this.win;
    this.reset();
    if (win && !win.isDestroyed()) win.destroy();
  }

  private reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.win = undefined;
    this.event = null;
  }
}
