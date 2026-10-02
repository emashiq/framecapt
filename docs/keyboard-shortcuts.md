# Keyboard shortcuts

Global shortcuts work from any app while Framelet is running (also with its window closed to the tray). Change them in **Settings → Shortcuts**; the Keyboard shortcuts help (`?` or `F1` in the main window) always shows what is configured right now.

## Global shortcuts (defaults)

| Action                        | Default        | Notes                                                                   |
| ----------------------------- | -------------- | ----------------------------------------------------------------------- |
| Screenshot: screen            | `Ctrl+Shift+1` | One screen: captured at once. Several: click the screen (or Enter).     |
| Screenshot: window            | `Ctrl+Shift+2` | Brings up Framelet's window picker.                                     |
| Screenshot: region            | `Ctrl+Shift+3` | Drag over the area, or use the arrow keys (below).                      |
| Record: screen                | `Ctrl+Shift+5` | Pressing it again while recording stops (and saves) the recording.      |
| Record: window                | `Ctrl+Shift+6` | Window picker first; the same key stops.                                |
| Record: region                | `Ctrl+Shift+7` | Selection overlay first; the same key stops.                            |
| Stop recording                | `Ctrl+Shift+0` | Also cancels a recording that is still starting (selection, countdown). |
| Pause or resume the recording | `Ctrl+Shift+9` | Toggles.                                                                |

Rules:

- A shortcut needs `Ctrl` or `Alt` (a bare key or `Shift` + key would be typed by accident). `F1`..`F24` and `PrintScreen` work without a modifier. The Windows key is not offered.
- Two actions cannot share one shortcut; Settings refuses it before saving. A shortcut can be turned off (`Backspace` or **Off** in Settings), shown as "Not set".
- `PrintScreen` is **not** a default because the Windows Snipping Tool owns it by default; you can still choose it.
- While a screenshot flow runs, screenshot shortcuts are ignored ("A capture is already in progress"). While a recording runs, screenshot shortcuts are ignored too.
- If the key combination is already held by another app, Windows refuses the registration. Framelet shows "Ctrl+Shift+1 is used by another app — choose a different shortcut" in Settings, a warning on the home screen and, once, a notification at startup. Nothing is registered for that action until you pick another one.

### About the defaults

`Ctrl+Shift+1..9` and `0` are not reserved by Windows itself, but other software uses them _inside_ its own window: Windows Terminal opens profiles with `Ctrl+Shift+1..9`, VS Code uses `Ctrl+Shift+5` (split terminal) and Windows' optional "switch input language" hot keys can be assigned to `Ctrl+Shift+0..9`. A global shortcut wins over those while Framelet runs. This list is from the vendors' documentation and general knowledge, not an exhaustive check of every program: that is exactly why conflicts are detected at registration and every shortcut is configurable.

## Choosing an area (screenshot and record region overlays)

| Keys                 | Does                                                         |
| -------------------- | ------------------------------------------------------------ |
| Drag                 | Draw a selection; drag it to move; drag a handle to resize.  |
| Arrow keys           | Start a centered selection (half the screen), then move 1 px |
| `Shift` + arrow keys | Move 10 px                                                   |
| `Alt` + arrow keys   | Resize 1 px (right and bottom edges); `Alt+Shift` 10 px      |
| `Enter`              | Capture / record the selection                               |
| `Esc`, right click   | Cancel (right click clears the selection first)              |
| `Tab`                | Move to the Capture / Cancel buttons                         |

Focus returns to the main window (and the button you used) when the overlay closes. A capture started by a shortcut while the window was hidden in the tray and then cancelled leaves the window hidden.

## Main window

`?` or `F1` opens the help. `Tab` / `Shift+Tab` move through the controls (the first stop is "Skip to content"). Dialogs trap focus and give it back. In the editor: `V C A R T X` pick tools, `Ctrl+S` saves (in your chosen format), `Ctrl+C` copies, `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo, `Ctrl+=` / `Ctrl+-` / `Ctrl+0` / `Ctrl+1` zoom, arrow keys move the selected mark, `Delete` removes it. History: arrows move, `Enter` opens, `Delete` removes from history (with Undo).
