import path from 'node:path';

/**
 * The taskbar/title-bar icon. A packaged Windows build uses the icon embedded in FrameCapt.exe; an
 * unpackaged run (npm start, e2e) would show Electron's, so it gets the .ico from the repository.
 * Linux has no embedded icon: it always gets the PNG (shipped next to the app as an extraResource).
 */
export function windowIconFor(
  platform: string,
  env: { isPackaged: boolean; appPath: string; resourcesPath: string },
): { icon?: string } {
  if (platform === 'linux') {
    const png = 'framecapt-logo-256.png';
    return {
      icon: env.isPackaged
        ? path.join(env.resourcesPath, png)
        : path.join(env.appPath, 'assets', 'brand', png),
    };
  }
  if (platform === 'win32' && !env.isPackaged) {
    return { icon: path.join(env.appPath, 'assets', 'app', 'framecapt.ico') };
  }
  return {};
}
