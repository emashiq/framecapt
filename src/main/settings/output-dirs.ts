import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_OUTPUT_SUBFOLDER,
  type EffectiveSettings,
  type Settings,
} from '../../shared/settings';

export interface DefaultFolders {
  pictures: string;
  videos: string;
}

/** The folders in use: the chosen one, or `Pictures/FrameCapt` and `Videos/FrameCapt`. */
export function resolveOutputDirs(settings: Settings, defaults: DefaultFolders): EffectiveSettings {
  return {
    screenshotsDir:
      settings.screenshots.outputDir ?? path.join(defaults.pictures, DEFAULT_OUTPUT_SUBFOLDER),
    recordingsDir:
      settings.recording.outputDir ?? path.join(defaults.videos, DEFAULT_OUTPUT_SUBFOLDER),
  };
}

/**
 * True when files can be created in `dir` (it is made when missing): a probe file is written and
 * removed again. A folder the user picked but cannot write to must be refused up front, not when a
 * long recording is about to be saved.
 */
export async function probeWritable(dir: string): Promise<boolean> {
  if (!path.isAbsolute(dir)) return false;
  const probe = path.join(dir, `.framecapt-probe-${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(probe, 'probe');
    await fs.promises.rm(probe, { force: true });
    return true;
  } catch {
    await fs.promises.rm(probe, { force: true }).catch(() => undefined);
    return false;
  }
}
