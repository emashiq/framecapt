/**
 * Decides what happens when the main window is asked to close while its editor tabs may hold unsaved
 * work. Pure logic (no Electron), so the "quit must always remain possible" rules are unit tested.
 *
 *   - Not dirty -> close.
 *   - Dirty, first attempt -> ask the renderer (`editor:confirmClose`) and keep the window open.
 *   - Dirty, a second attempt while the question is still open -> close. A hung or confused
 *     renderer therefore can never trap the user in the app.
 *   - Answer "discard" -> the next close goes through. Answer "keep editing" -> asking resets.
 */
export class CloseGuard {
  private dirty = false;
  private asked = false;
  private discardConfirmed = false;

  setDirty(dirty: boolean): void {
    this.dirty = dirty;
    if (!dirty) this.asked = false;
  }

  /** The OS is ending the session (logoff, shutdown): never hold that up. */
  allowClose(): void {
    this.discardConfirmed = true;
  }

  /** Called from the window's 'close' event. */
  onCloseRequested(): 'close' | 'ask' {
    if (this.discardConfirmed || !this.dirty) return 'close';
    if (this.asked) return 'close';
    this.asked = true;
    return 'ask';
  }

  /** The renderer answered the question. Returns whether to close the window now. */
  resolve(discard: boolean): boolean {
    this.asked = false;
    if (!discard) return false;
    this.discardConfirmed = true;
    return true;
  }
}
