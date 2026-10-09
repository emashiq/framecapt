/**
 * What a meeting looks like from outside: window titles, window classes and process names. Pure
 * and Electron-free so the detector and the tests share it. English window titles only (the
 * signatures below are the English strings of each app); other languages are not detected.
 * Titles are inspected in memory and never stored or logged.
 */

export const MEETING_APPS = ['meet', 'zoom', 'teams', 'webex'] as const;
export type MeetingApp = (typeof MEETING_APPS)[number];

export const MEETING_APP_LABELS: Record<MeetingApp, string> = {
  meet: 'Google Meet',
  zoom: 'Zoom',
  teams: 'Microsoft Teams',
  webex: 'Webex',
};

/** The facts of a window the signatures need (a subset of the window probe's `WinInfo`). */
export interface MeetingWindowFacts {
  title: string;
  className: string;
  /** Lowercase exe basename; empty when unknown (the fallback probe). */
  exe: string;
}

const BROWSER_EXES: readonly string[] = ['chrome.exe', 'msedge.exe', 'brave.exe', 'firefox.exe'];

/** Whether an exe basename is a web browser. */
export function isBrowserExe(exe: string): boolean {
  return BROWSER_EXES.includes(exe);
}
const WEBEX_EXES: readonly string[] = ['webexmta.exe', 'ciscocollabhost.exe', 'atmgr.exe'];
const TEAMS_EXES: readonly string[] = ['ms-teams.exe', 'teams.exe'];
const TEAMS_MIC_APPS: readonly string[] = ['msteams_8wekyb3d8bbwe', ...TEAMS_EXES];
const ZOOM_MEETING_CLASSES: readonly string[] = [
  'ConfMultiTabContentWndClass',
  'ZPContentViewWndClass',
];

const ZERO_WIDTH = new RegExp('[\\u200b-\\u200d\\u2060\\ufeff]', 'g');

/** Zero-width characters (Edge puts one in its title suffix) removed, whitespace collapsed. */
function clean(title: string): string {
  return title.replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}

/** `Meet – abc-defg-hij` (en dash; some builds use a hyphen or em dash) at the start of the title. */
const MEET_CALL = /^Meet\s*[–—-]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}(?![a-z])/i;

/** The exe is a browser, or unknown (then only the title can tell). */
function isBrowserOrUnknown(exe: string): boolean {
  return exe === '' || BROWSER_EXES.includes(exe);
}

/** The Teams desktop's main window: the app's navigation pages, not a call. */
const TEAMS_MAIN_TITLE =
  /^(Chat|Activity|Calendar|Calls|Teams|Files|Apps|Home|Viva Engage|Communities|OneDrive|Assignments|Mentions|Saved|Search)\b.*\|\s*Microsoft Teams$/i;

export interface MeetingMatch {
  app: MeetingApp;
  /** `window+mic`: the microphone of that app is in use as well. */
  confidence: 'window' | 'window+mic';
}

/**
 * Whether a window is a meeting window of a supported app. `micApps` is the probe's list of apps
 * using the microphone: only a corroborating signal (it can be stale), except for Teams, whose
 * windows carry no fixed title, where window and microphone are both needed.
 */
export function matchMeetingWindow(
  info: MeetingWindowFacts,
  micApps: readonly string[],
): MeetingMatch | null {
  const title = clean(info.title);
  const { className, exe } = info;
  const browserMic = exe !== '' && micApps.includes(exe);

  // Google Meet: the call tab is the active tab of a browser window.
  if (isBrowserOrUnknown(exe) && MEET_CALL.test(title)) {
    return { app: 'meet', confidence: browserMic ? 'window+mic' : 'window' };
  }

  // Zoom desktop: the meeting window classes; the home window (ZPPTMainFrmWndClassEx) is not one.
  const zoomMic = micApps.includes('zoom.exe') ? 'window+mic' : 'window';
  if ((exe === 'zoom.exe' || exe === '') && ZOOM_MEETING_CLASSES.includes(className)) {
    return { app: 'zoom', confidence: zoomMic };
  }
  if (exe === 'zoom.exe' && className === '' && title === 'Zoom Meeting') {
    return { app: 'zoom', confidence: zoomMic };
  }
  // Zoom web client.
  if (BROWSER_EXES.includes(exe) && /\bZoom Meeting\b/.test(title)) {
    return { app: 'zoom', confidence: browserMic ? 'window+mic' : 'window' };
  }

  // Teams desktop: any non-main TeamsWebView window, while Teams uses the microphone.
  if (TEAMS_EXES.includes(exe) && className === 'TeamsWebView') {
    if (title === '' || TEAMS_MAIN_TITLE.test(title) || title.startsWith('Sharing control bar')) {
      return null;
    }
    return micApps.some((app) => TEAMS_MIC_APPS.includes(app))
      ? { app: 'teams', confidence: 'window+mic' }
      : null;
  }
  // Teams on the web: the browser tab title and the browser's microphone.
  if (BROWSER_EXES.includes(exe) && /\|\s*Microsoft Teams(?: - .*)?$/.test(title) && browserMic) {
    return { app: 'teams', confidence: 'window+mic' };
  }

  // Webex.
  if (WEBEX_EXES.includes(exe) && /\bWebex\b/.test(title)) {
    return { app: 'webex', confidence: 'window' };
  }
  return null;
}

export interface ShareIndicatorMatch {
  /** `browser`: Chrome/Edge's own indicator; it does not say which site shares. */
  app: MeetingApp | 'browser';
  kind: 'screen' | 'window';
}

/**
 * Whether a window is the "you are sharing" indicator of a browser, Zoom or Teams. A Chrome tab
 * share only shows an infobar inside the page (not a window), so it cannot be detected.
 */
export function matchShareIndicator(info: MeetingWindowFacts): ShareIndicatorMatch | null {
  const title = clean(info.title);
  const { className, exe } = info;
  if (className === 'Chrome_WidgetWin_1' && isBrowserOrUnknown(exe)) {
    const match = /\bis sharing (your screen|a window)\.?$/i.exec(title);
    if (match) {
      return { app: 'browser', kind: match[1]?.toLowerCase() === 'a window' ? 'window' : 'screen' };
    }
  }
  if (className === 'ZPFloatToolbarClass' && title === 'Screen sharing meeting controls') {
    return { app: 'zoom', kind: 'screen' };
  }
  if (className === 'TeamsWebView' && title.startsWith('Sharing control bar | Microsoft Teams')) {
    return { app: 'teams', kind: 'screen' };
  }
  return null;
}

/**
 * Whether the meeting's window still shows the meeting. A Meet call is only visible while its tab
 * is the browser's active tab (the title is the active tab's); the desktop apps' windows are the
 * meeting for as long as they exist.
 */
export function isMeetingStillShown(app: MeetingApp, info: MeetingWindowFacts): boolean {
  return app === 'meet' ? MEET_CALL.test(clean(info.title)) : true;
}
