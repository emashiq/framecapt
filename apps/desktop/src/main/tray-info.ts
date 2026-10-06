/** What the About screen and the tests may know about the tray icon. */
export interface TrayInfo {
  active: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
}
