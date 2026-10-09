import { describe, expect, it } from 'vitest';
import {
  isMeetingStillShown,
  matchMeetingWindow,
  matchShareIndicator,
} from '../../src/shared/meeting-signatures';

const win = (title: string, className: string, exe: string) => ({ title, className, exe });
const TEAMS_PKG = 'msteams_8wekyb3d8bbwe';

describe('matchMeetingWindow', () => {
  it('matches a Google Meet call in each browser, with an en dash or a hyphen', () => {
    expect(
      matchMeetingWindow(
        win('Meet – abc-defg-hij - Google Chrome', 'Chrome_WidgetWin_1', 'chrome.exe'),
        [],
      ),
    ).toEqual({ app: 'meet', confidence: 'window' });
    expect(matchMeetingWindow(win('Meet - abc-defg-hij - Brave', '', 'brave.exe'), [])?.app).toBe(
      'meet',
    );
    // Edge's suffix carries a zero-width space.
    expect(
      matchMeetingWindow(win('Meet – abc-defg-hij - Microsoft​ Edge', '', 'msedge.exe'), [])?.app,
    ).toBe('meet');
  });

  it('adds the microphone to the confidence when the browser uses it', () => {
    expect(
      matchMeetingWindow(win('Meet – abc-defg-hij - Google Chrome', '', 'chrome.exe'), [
        'chrome.exe',
      ]),
    ).toEqual({ app: 'meet', confidence: 'window+mic' });
  });

  it('matches a Meet title when the exe is unknown (fallback probe)', () => {
    expect(matchMeetingWindow(win('Meet – abc-defg-hij - Google Chrome', '', ''), [])?.app).toBe(
      'meet',
    );
  });

  it('ignores the Meet landing page, a random tab and a Meet title in another app', () => {
    expect(matchMeetingWindow(win('Google Meet - Google Chrome', '', 'chrome.exe'), [])).toBeNull();
    expect(matchMeetingWindow(win('Meet – Video calls', '', 'chrome.exe'), [])).toBeNull();
    expect(
      matchMeetingWindow(win('YouTube - Google Chrome', '', 'chrome.exe'), ['chrome.exe']),
    ).toBeNull();
    expect(matchMeetingWindow(win('Meet – abc-defg-hij', '', 'notepad.exe'), [])).toBeNull();
  });

  it('matches Zoom meeting windows but not the home window', () => {
    expect(
      matchMeetingWindow(win('Zoom Meeting', 'ConfMultiTabContentWndClass', 'zoom.exe'), [])?.app,
    ).toBe('zoom');
    expect(
      matchMeetingWindow(win('Zoom Workplace', 'ConfMultiTabContentWndClass', 'zoom.exe'), [])?.app,
    ).toBe('zoom');
    expect(matchMeetingWindow(win('', 'ZPContentViewWndClass', 'zoom.exe'), [])?.app).toBe('zoom');
    expect(matchMeetingWindow(win('Zoom Meeting', '', 'zoom.exe'), [])?.app).toBe('zoom');
    expect(
      matchMeetingWindow(win('Zoom Workplace', 'ZPPTMainFrmWndClassEx', 'zoom.exe'), []),
    ).toBeNull();
    expect(
      matchMeetingWindow(win('Zoom Meeting', 'ZPPTMainFrmWndClassEx', 'zoom.exe'), []),
    ).toBeNull();
  });

  it('matches the Zoom web client in a browser', () => {
    expect(matchMeetingWindow(win('Zoom Meeting - Google Chrome', '', 'chrome.exe'), [])?.app).toBe(
      'zoom',
    );
  });

  it('needs the microphone for Teams, and skips its main window', () => {
    const call = win('Weekly sync', 'TeamsWebView', 'ms-teams.exe');
    expect(matchMeetingWindow(call, [])).toBeNull();
    expect(matchMeetingWindow(call, ['slack.exe'])).toBeNull();
    expect(matchMeetingWindow(call, [TEAMS_PKG])).toEqual({
      app: 'teams',
      confidence: 'window+mic',
    });
    const main = win('Chat | Microsoft Teams', 'TeamsWebView', 'ms-teams.exe');
    expect(matchMeetingWindow(main, [TEAMS_PKG])).toBeNull();
    const bar = win('Sharing control bar | Microsoft Teams', 'TeamsWebView', 'ms-teams.exe');
    expect(matchMeetingWindow(bar, [TEAMS_PKG])).toBeNull();
  });

  it('matches Teams on the web only with the browser microphone', () => {
    const tab = win('Weekly sync | Microsoft Teams - Google Chrome', '', 'chrome.exe');
    expect(matchMeetingWindow(tab, [])).toBeNull();
    expect(matchMeetingWindow(tab, ['chrome.exe'])?.app).toBe('teams');
  });

  it('matches Webex windows by exe and title', () => {
    expect(matchMeetingWindow(win('Webex Meeting', '', 'webexmta.exe'), [])?.app).toBe('webex');
    expect(matchMeetingWindow(win('Cisco Webex', '', 'atmgr.exe'), [])?.app).toBe('webex');
    expect(matchMeetingWindow(win('Webex docs - Google Chrome', '', 'chrome.exe'), [])).toBeNull();
    expect(matchMeetingWindow(win('Settings', '', 'webexmta.exe'), [])).toBeNull();
  });
});

describe('matchShareIndicator', () => {
  it('recognizes the Chrome and Edge sharing indicators', () => {
    expect(
      matchShareIndicator(
        win('meet.google.com is sharing your screen.', 'Chrome_WidgetWin_1', 'chrome.exe'),
      ),
    ).toEqual({ app: 'browser', kind: 'screen' });
    expect(
      matchShareIndicator(
        win('meet.google.com is sharing a window.', 'Chrome_WidgetWin_1', 'msedge.exe'),
      ),
    ).toEqual({ app: 'browser', kind: 'window' });
  });

  it('ignores a tab share, other classes and ordinary Chrome windows', () => {
    expect(
      matchShareIndicator(
        win('meet.google.com is sharing a Chrome tab.', 'Chrome_WidgetWin_1', 'chrome.exe'),
      ),
    ).toBeNull();
    expect(
      matchShareIndicator(win('x is sharing your screen.', 'Notepad', 'chrome.exe')),
    ).toBeNull();
    expect(
      matchShareIndicator(win('Inbox - Google Chrome', 'Chrome_WidgetWin_1', 'chrome.exe')),
    ).toBeNull();
  });

  it('recognizes Zoom and Teams share bars by their title', () => {
    expect(
      matchShareIndicator(
        win('Screen sharing meeting controls', 'ZPFloatToolbarClass', 'zoom.exe'),
      ),
    ).toEqual({
      app: 'zoom',
      kind: 'screen',
    });
    expect(matchShareIndicator(win('Other panel', 'ZPFloatToolbarClass', 'zoom.exe'))).toBeNull();
    expect(
      matchShareIndicator(
        win('Sharing control bar | Microsoft Teams', 'TeamsWebView', 'ms-teams.exe'),
      )?.app,
    ).toBe('teams');
  });
});

describe('isMeetingStillShown', () => {
  it('needs the Meet tab to be the active tab', () => {
    expect(
      isMeetingStillShown('meet', win('Meet – abc-defg-hij - Google Chrome', '', 'chrome.exe')),
    ).toBe(true);
    expect(isMeetingStillShown('meet', win('Inbox - Google Chrome', '', 'chrome.exe'))).toBe(false);
  });

  it('treats an existing desktop-app window as the meeting', () => {
    expect(isMeetingStillShown('zoom', win('anything', '', 'zoom.exe'))).toBe(true);
    expect(isMeetingStillShown('teams', win('anything', '', 'ms-teams.exe'))).toBe(true);
    expect(isMeetingStillShown('webex', win('anything', '', 'webexmta.exe'))).toBe(true);
  });
});
