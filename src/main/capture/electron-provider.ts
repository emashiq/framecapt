import { BrowserWindow, desktopCapturer, screen, type Display, type NativeImage } from 'electron';
import { THUMBNAIL_MAX_WIDTH, type SourceInfo } from '../../shared/capture-schemas';
import { isOwnWindowSource } from './source-id';
import type { CaptureProvider, DisplayInfo, ListSourcesOptions } from './types';

const APP_ICON_SIZE = 32;

function toDisplayInfo(display: Display, primaryId: number): DisplayInfo {
  const { bounds, scaleFactor } = display;
  return {
    id: String(display.id),
    label: display.label || `Display ${display.id}`,
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    scaleFactor,
    rotation: display.rotation,
    // On Windows Electron reports bounds already in the rotated orientation, so no 90/270 swap.
    // Verified on the host by the native test (stream size == physicalSize); rotated monitors
    // were not available to test.
    physicalSize: {
      width: Math.round(bounds.width * scaleFactor),
      height: Math.round(bounds.height * scaleFactor),
    },
    isPrimary: display.id === primaryId,
  };
}

function imageToDataUrl(image: NativeImage | null, maxWidth: number): string | undefined {
  if (!image || image.isEmpty()) return undefined;
  const resized = image.getSize().width > maxWidth ? image.resize({ width: maxWidth }) : image;
  return resized.toDataURL();
}

export class ElectronCaptureProvider implements CaptureProvider {
  listDisplays(): DisplayInfo[] {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((display) => toDisplayInfo(display, primaryId));
  }

  async listSources(options: ListSourcesOptions): Promise<SourceInfo[]> {
    const width = Math.min(options.thumbnailWidth ?? 0, THUMBNAIL_MAX_WIDTH);
    const wantsWindows = options.types.includes('window');
    const raw = await desktopCapturer.getSources({
      types: options.types,
      // Aspect ratio is preserved inside the box, so the width is the effective limit.
      thumbnailSize: { width, height: width },
      fetchWindowIcons: wantsWindows,
    });

    // Never offer FrameCapt's own windows (toolbar, overlay, main) as capture sources.
    const own = BrowserWindow.getAllWindows().map((win) => win.getMediaSourceId());
    const displays = screen.getAllDisplays();

    const sources: SourceInfo[] = [];
    for (const source of raw) {
      const kind = source.id.startsWith('screen:') ? 'screen' : 'window';
      if (kind === 'window' && isOwnWindowSource(source.id, own)) continue;

      const info: SourceInfo = { id: source.id, name: source.name, kind };
      if (kind === 'screen') {
        const displayId =
          source.display_id || (displays.length === 1 ? String(displays[0]?.id) : '');
        if (displayId) info.displayId = displayId;
      }
      const thumbnail = width > 0 ? imageToDataUrl(source.thumbnail, width) : undefined;
      if (thumbnail) info.thumbnail = thumbnail;
      const appIcon = kind === 'window' ? imageToDataUrl(source.appIcon, APP_ICON_SIZE) : undefined;
      if (appIcon) info.appIcon = appIcon;
      sources.push(info);
    }
    return sources;
  }
}
