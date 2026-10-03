/** What the OS lets FrameCapt do. Windows is the product; Linux x64 is an experimental build. */
export interface PlatformCapabilities {
  /** Chromium's `audio: 'loopback'` (system audio) exists on Windows only. */
  systemAudio: boolean;
  /** One line shown instead of a hint when system audio is unavailable. */
  systemAudioReason?: string;
  /** `setContentProtection` hides the recording toolbar from the capture (a no-op on Linux). */
  toolbarExcludedFromCapture: boolean;
  /** One line shown in the record options when the toolbar can appear in the recording. */
  toolbarNote?: string;
}

export const SYSTEM_AUDIO_UNAVAILABLE_ON_LINUX = 'Not available on Linux yet';
export const TOOLBAR_MAY_BE_RECORDED_ON_LINUX =
  'The recording toolbar may appear in full-screen recordings on Linux.';

export function platformCapabilities(platform: string): PlatformCapabilities {
  if (platform === 'linux') {
    return {
      systemAudio: false,
      systemAudioReason: SYSTEM_AUDIO_UNAVAILABLE_ON_LINUX,
      toolbarExcludedFromCapture: false,
      toolbarNote: TOOLBAR_MAY_BE_RECORDED_ON_LINUX,
    };
  }
  return { systemAudio: true, toolbarExcludedFromCapture: true };
}
