import type { ElectronApplication } from '@playwright/test';

/**
 * Ends the app without close events. A window that still holds an unsaved screenshot asks before
 * closing (on purpose), so `electronApp.close()` would wait for an answer nobody gives.
 */
export async function exitApp(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
  await app.close().catch(() => undefined);
}
