import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';

/**
 * Screenshots, videos and step guides are edited in tabs of the main window (ADR-050), next to the
 * pinned Home tab. The helpers keep the names they had when the editors had a window of their own:
 * `editorPage` is the main window once an editor tab is open.
 */

/** The main window (the first one the app opens). */
export function mainPage(app: ElectronApplication): Page {
  const main = app.windows().find((page) => page.url().endsWith('#/'));
  if (!main) throw new Error('the main window is not open');
  return main;
}

/** The editor tabs, in order (the pinned Home tab is not one of them). */
export function tabs(page: Page): Locator {
  return page.getByTestId('editor-tab');
}

/** The main window, once an editor tab is open and showing (it opens on a capture or an Edit). */
export async function editorPage(app: ElectronApplication, timeout = 20_000): Promise<Page> {
  let main: Page | undefined;
  await expect
    .poll(
      () => {
        main = app.windows().find((page) => page.url().endsWith('#/'));
        return main !== undefined;
      },
      { timeout, message: 'the main window is not open' },
    )
    .toBe(true);
  const page = main as unknown as Page;
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('[data-testid="editor-panel"][data-active="true"]')).toBeVisible({
    timeout,
  });
  return page;
}

/** True while an editor tab is open. */
export async function hasEditorPage(app: ElectronApplication): Promise<boolean> {
  return (await tabs(mainPage(app)).count()) > 0;
}

/** Waits until every editor tab is closed. */
export async function expectEditorClosed(app: ElectronApplication): Promise<void> {
  await expect(tabs(mainPage(app))).toHaveCount(0, { timeout: 15_000 });
}

/** The panel of the tab that is showing (every open tab stays mounted, so ids repeat across panels). */
export function activePanel(page: Page): Locator {
  return page.locator('[data-testid="editor-panel"][data-active="true"]');
}

/** Shows the pinned Home tab (the section it was on stays). */
export async function showHome(page: Page): Promise<void> {
  await page.getByTestId('home-tab').click();
  await expect(page.getByTestId('home-panel')).toHaveAttribute('data-active', 'true');
}
