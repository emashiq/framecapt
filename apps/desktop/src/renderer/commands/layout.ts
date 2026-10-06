/**
 * How much of the title bar fits. `width` is the room the bar may use: the window width without the
 * window-button overlay (`env(titlebar-area-width)`). Pure, so the thresholds are unit-tested.
 */
export interface TitleBarLayout {
  /** The File, View and Help menus as one menu button. */
  collapsedMenus: boolean;
  /** The command center search box as an icon button. */
  iconSearch: boolean;
}

/** Below this the three menus no longer leave the search box enough room. */
export const COLLAPSE_MENUS_BELOW = 640;
/** Below this even a shrunken search box does not fit next to the logo. */
export const ICON_SEARCH_BELOW = 480;

export function titleBarLayout(width: number): TitleBarLayout {
  return { collapsedMenus: width < COLLAPSE_MENUS_BELOW, iconSearch: width < ICON_SEARCH_BELOW };
}
