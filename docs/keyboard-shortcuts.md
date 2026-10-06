# Keyboard shortcuts

Global shortcuts work from any app while FrameCapt is running (also with its window closed to the tray). Change them in **Settings → Shortcuts**; the Keyboard shortcuts help (`?` or `F1` in the main window) always shows what is configured right now.

## Global shortcuts (defaults)

| Action                        | Default        | Notes                                                                   |
| ----------------------------- | -------------- | ----------------------------------------------------------------------- |
| Screenshot: screen            | `Ctrl+Shift+1` | One screen: captured at once. Several: click the screen (or Enter).     |
| Screenshot: window            | `Ctrl+Shift+2` | Brings up FrameCapt's window picker.                                    |
| Screenshot: region            | `Ctrl+Shift+3` | Drag over the area, or use the arrow keys (below).                      |
| Record: screen                | `Ctrl+Shift+5` | Pressing it again while recording stops (and saves) the recording.      |
| Record: window                | `Ctrl+Shift+6` | Window picker first; the same key stops.                                |
| Record: region                | `Ctrl+Shift+7` | Selection overlay first; the same key stops.                            |
| Stop recording                | `Ctrl+Shift+0` | Also cancels a recording that is still starting (selection, countdown). |
| Pause or resume the recording | `Ctrl+Shift+9` | Toggles.                                                                |

Rules:

- A shortcut needs `Ctrl` or `Alt` (a bare key or `Shift` + key would be typed by accident). `F1`..`F24` and `PrintScreen` work without a modifier. The Windows key is not offered.
- Two actions cannot share one shortcut. When you press a combination that another action already has, Settings says "already used by <action>" and offers **Swap**: the two actions exchange their shortcuts in one saved change (if the action you are editing had none, the other one becomes "Not set"). A shortcut can be turned off (`Backspace` or **Off** in Settings), shown as "Not set".
- `PrintScreen` is **not** a default because the Windows Snipping Tool owns it by default; you can still choose it, and Settings shows a note next to it saying the Snipping Tool may answer first.
- Combinations the system keeps for itself are refused **before** anything is registered, with the reason in Settings (see [Reserved combinations](#reserved-combinations)).
- While a screenshot flow runs, screenshot shortcuts are ignored ("A capture is already in progress"). While a recording runs, screenshot shortcuts are ignored too.
- If the key combination is already held by another app, Windows refuses the registration. FrameCapt shows "Ctrl+Shift+1 is used by another app — choose a different shortcut" in Settings, a warning on the home screen and, once, a notification at startup. Nothing is registered for that action until you pick another one.

### Reserved combinations

The check (`reservedCheck` in `apps/desktop/src/shared/shortcuts.ts`) runs in main when you choose a combination, and again when shortcuts are registered
(a settings file from before this check may hold one; it is then shown as "invalid" with the reason and nothing is registered).

| Platform | Refused                                                                                                                                                                      | Allowed with a note                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Windows  | `Ctrl+Alt+Delete`, `Ctrl+Shift+Esc`, `Alt+F4`, `Alt+Tab`, `Alt+Shift+Tab`, `Ctrl+Esc`, `Alt+Esc`, `Alt+Space`, `F12` (reserved for debuggers); every Windows-key combination | `PrintScreen` (also with a modifier): the Snipping Tool may own it |
| Linux    | `Ctrl+Alt+T`, `Ctrl+Alt+L`, `Ctrl+Alt+Delete`, `Alt+Tab`, `Alt+Shift+Tab`, `Alt+F4`, `Alt+F2`, `Alt+Space`, `Ctrl+Alt+` + arrow, `Ctrl+Alt+F1`..`F12`; Super combinations    | `PrintScreen`: the desktop's screenshot tool may own it            |
| Both     | `Ctrl+C`, `Ctrl+V`, `Ctrl+X`, `Ctrl+Z`, `Ctrl+Y`, `Ctrl+A` (a global shortcut there would break editing in every other app)                                                  |                                                                    |

The Windows (Super) key is never accepted. The Linux list is the common GNOME/KDE defaults, not every desktop; anything else another program holds is still found by the OS
refusing the registration ("used by another app"). A global shortcut also cannot equal an editor key (below), because the global one would take it away from the editor.

### About the defaults

`Ctrl+Shift+1..9` and `0` are not reserved by Windows itself, but other software uses them _inside_ its own window: Windows Terminal opens profiles with `Ctrl+Shift+1..9`, VS Code uses `Ctrl+Shift+5` (split terminal) and Windows' optional "switch input language" hot keys can be assigned to `Ctrl+Shift+0..9`. A global shortcut wins over those while FrameCapt runs. This list is from the vendors' documentation and general knowledge, not an exhaustive check of every program: that is exactly why conflicts are detected at registration and every shortcut is configurable.

## Command center and menus (customizable)

The title bar has a menu bar (**File**, **View**, **Help**) and a search box in the middle, the command center. These two keys open it from anywhere in the main window (the editor included); they are in-app keys, not registered with the operating system, and are edited on the same Settings, Shortcuts page (group **Command center**) and listed in the Keyboard shortcuts help:

| Action                                       | Default        |
| -------------------------------------------- | -------------- |
| Command center: search commands and captures | `Ctrl+K`       |
| Command center: commands only                | `Ctrl+Shift+P` |

In the command center: type to search, `Up` / `Down` choose, `Enter` runs the highlighted command (a saved capture opens in History), `Shift+Enter` on a saved capture shows it in its folder, `Esc` closes it. A command that cannot run now (signed out, Viewer role, a recording in progress) is listed with the reason and `Enter` does nothing. The menu bar works with the arrow keys (`Down` or `Enter` opens a menu, `Left` / `Right` move between menus, `Esc` closes and returns to the menu button); each item shows its live shortcut. There is no `Alt` access key for the menus.

## Editor shortcuts (customizable)

The editor's own keys are listed under **Editor** on the same Settings, Shortcuts page, with the same recorder, **Swap**, turn-off and restore-default controls. They work only
inside the screenshot editor (no operating-system registration, no reserved-combination check), so a bare key is allowed. The editor ignores all of them while a text field has
focus (the Text tool's box, any input), so a letter bound to a tool never gets in the way of typing.

| Action                        | Default                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Select tool                   | `V`                                                                              |
| Crop tool                     | `C`                                                                              |
| Arrow tool                    | `A`                                                                              |
| Rectangle tool                | `R`                                                                              |
| Text tool                     | `T`                                                                              |
| Redact tool                   | `X`                                                                              |
| Ellipse tool                  | `O`                                                                              |
| Line tool                     | `L`                                                                              |
| Pen tool                      | `P`                                                                              |
| Highlighter                   | `H`                                                                              |
| Blur / pixelate               | `B`                                                                              |
| Step number                   | `N`                                                                              |
| Callout                       | `D`                                                                              |
| Spotlight                     | `S`                                                                              |
| Magnifier                     | `M`                                                                              |
| Stamp                         | `E`                                                                              |
| Ruler                         | `I`                                                                              |
| Duplicate                     | `Ctrl+D`                                                                         |
| Bring forward / Send backward | `Ctrl+]` / `Ctrl+[`                                                              |
| Bring to front / Send to back | `Ctrl+Shift+]` / `Ctrl+Shift+[`                                                  |
| Select all marks              | `Ctrl+A`                                                                         |
| Undo                          | `Ctrl+Z`                                                                         |
| Redo                          | `Ctrl+Shift+Z` (`Ctrl+Y` also redoes, unless you bind it to something else)      |
| Save                          | `Ctrl+S`                                                                         |
| Quick save (no dialog)        | `Ctrl+Shift+S` (saves to your screenshots folder at once; also in the Save menu) |
| Copy                          | `Ctrl+C` (with text selected on the page, the normal copy runs)                  |
| Zoom in                       | `Ctrl+=` (also `Ctrl+Shift+=`)                                                   |
| Zoom out                      | `Ctrl+-`                                                                         |
| Fit to window                 | `Ctrl+0`                                                                         |
| Zoom to 100 %                 | `Ctrl+1`                                                                         |

Fixed (they are how a mark is edited, so they cannot be bound or rebound): `Delete` and `Backspace` remove the selected mark, `Enter` applies the crop, `Esc` cancels, the arrow
keys move the selected marks (`Shift` 10 px), `Space` pans, `Tab` moves focus. Holding `Alt` while dragging a mark turns snapping off for that drag; `Shift`-click adds a mark to the selection. Two editor actions cannot share a combination, and an editor key cannot equal a global shortcut.
The toolbar tooltips and the help (`?`) show the keys as they are set now.

**Reset all shortcuts** (top right of the page, after a confirmation) puts back both the global and the editor shortcuts; the filter box above the list narrows it by action name or key.
Where they are stored: `settings.json`, sections `shortcuts` and `editorShortcuts`. A file written before `editorShortcuts` existed loads unchanged with the defaults (no
settings version change; a file with a duplicate or unusable editor key is set aside like any other invalid settings file).

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

`?` or `F1` opens the help. `Tab` / `Shift+Tab` move through the controls (the first stop is "Skip to content"). Dialogs trap focus and give it back. In the editor (defaults; see [Editor shortcuts](#editor-shortcuts-customizable) to change them): `V C A R T X` and the newer tool keys (`O L P H B N D S M E I`) pick tools, `Ctrl+D` duplicates, `Ctrl+]` / `Ctrl+[` reorder, `Ctrl+S` saves (in your chosen format), `Ctrl+C` copies, `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo, `Ctrl+=` / `Ctrl+-` / `Ctrl+0` / `Ctrl+1` zoom, arrow keys move the selected mark, `Delete` removes it. History: arrows move, `Enter` opens, `Delete` removes from history (with Undo).

## History (the grid)

These work inside History and are not configurable. Arrow keys, `Home` and `End` move between cards; a plain click or `Enter` still opens the card.

| Action                                    | Key                                                               |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Select or deselect a card                 | `Ctrl`-click, the checkbox on the card, or `Ctrl+Space`           |
| Select a range                            | `Shift`-click, or `Shift+Arrow` (`Ctrl+Shift`-click adds a range) |
| Select every card in the list             | `Ctrl+A`                                                          |
| Clear the selection                       | `Esc`                                                             |
| Open the card's menu                      | Right-click, `Shift+F10` or the Menu key                          |
| Remove the card (or all selected) entries | `Delete` (several: after a confirmation, with Undo)               |

## Video editor

These work inside the video editor (History > a recording > **Edit video**) and are not configurable. They are ignored while you type in a field, and `Space` does not fire while a button has the keyboard.

| Action                                                                      | Key                                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Play or pause                                                               | `Space` (playback skips cut pieces and stops at the end of the trim) |
| Step one frame back or forward                                              | `Left` / `Right` (`Shift`: one second)                               |
| Jump to the start or end of the trim                                        | `Home` / `End`                                                       |
| Mark the start / end of a range to cut                                      | `I` / `O`                                                            |
| Remove the selected item, restore the selected cut, or cut the marked range | `Delete`                                                             |
| Undo / redo                                                                 | `Ctrl+Z` / `Ctrl+Shift+Z` (also `Ctrl+Y`)                            |
| Save the project now (it also saves by itself)                              | `Ctrl+S`                                                             |
| Cancel the armed tool or crop mode, or clear the selection                  | `Esc`                                                                |
| Zoom the timeline around the pointer                                        | `Ctrl` + mouse wheel (a plain wheel scrolls sideways)                |
| Move an item or an edge without snapping                                    | hold `Alt` while dragging                                            |
| Nudge a trim handle                                                         | focus it, then `Left` / `Right` (`Shift`: one second)                |

## Recording toolbar

The toolbar's **Hide controls** button shrinks it to a small recording indicator (timer and a button to bring the controls back). Recording continues, and the global Pause and Stop shortcuts keep working while the controls are hidden.
