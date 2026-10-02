# Moves the mouse pointer and left-clicks with the Win32 SendInput API (real, OS-level mouse input).
# Usage: powershell -File click-at.ps1 <x> <y>      (physical screen coordinates)
# Used by scripts/smoke-installed.mjs to pick a display in Framelet's own selection overlay.
param([Parameter(Mandatory = $true)][int]$X, [Parameter(Mandatory = $true)][int]$Y)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FrameletMouse {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit, Size = 40)]
  public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; }
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  public static uint Button(bool up) {
    INPUT[] inputs = new INPUT[1];
    inputs[0].type = 0; // INPUT_MOUSE
    inputs[0].mi.dwFlags = up ? 0x0004u : 0x0002u; // MOUSEEVENTF_LEFTUP / LEFTDOWN
    return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@

[void][FrameletMouse]::SetProcessDPIAware()
if (-not [FrameletMouse]::SetCursorPos($X, $Y)) { throw "SetCursorPos failed" }
Start-Sleep -Milliseconds 150
# A little real movement first, so the page sees the pointer on its display before the click.
[void][FrameletMouse]::SetCursorPos($X + 1, $Y + 1)
Start-Sleep -Milliseconds 80
[void][FrameletMouse]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 80
if ([FrameletMouse]::Button($false) -ne 1) { throw "SendInput failed (button down)" }
Start-Sleep -Milliseconds 60
if ([FrameletMouse]::Button($true) -ne 1) { throw "SendInput failed (button up)" }
