import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';

/**
 * Screenshots and videos are edited in the Editor window (one window, one tab per item), a window
 * of its own at `#/editor`. These helpers find it and the main window among the app's windows.
 */
const isEditor = (page: Page): boolean => page.url().includes('#/editor');

/** The Editor window, once it exists (made on the first open, closed with its last tab). */
export async function editorPage(app: ElectronApplication, timeout = 20_000): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      () => {
        found = app.windows().find(isEditor);
        return found !== undefined;
      },
      { timeout, message: 'the Editor window did not open' },
    )
    .toBe(true);
  const page = found as unknown as Page;
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/** True while an Editor window is open. */
export function hasEditorPage(app: ElectronApplication): boolean {
  return app.windows().some(isEditor);
}

/** The main window (the first one the app opens). */
export function mainPage(app: ElectronApplication): Page {
  const main = app.windows().find((page) => page.url().endsWith('#/'));
  if (!main) throw new Error('the main window is not open');
  return main;
}

/** Waits until the Editor window is gone. */
export async function expectEditorClosed(app: ElectronApplication): Promise<void> {
  await expect.poll(() => hasEditorPage(app), { timeout: 15_000 }).toBe(false);
}

/** The panel of the tab that is showing (every open tab stays mounted, so ids repeat across panels). */
export function activePanel(editor: Page): Locator {
  return editor.locator('[data-testid="editor-panel"][data-active="true"]');
}

/** The tab strip's tabs, in order. */
export function tabs(editor: Page): Locator {
  return editor.getByTestId('editor-tab');
}
