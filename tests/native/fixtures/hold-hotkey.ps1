# Holds a system-wide hotkey the way another application would (RegisterHotKey), so the native test
# can check that Framelet reports the combination as "used by another app". Writes "ok" or "fail"
# to the ready file, then waits (message loop) until the process is killed.
# Usage: powershell -File hold-hotkey.ps1 <ready-file> <modifiers-mask> <virtual-key>
#   mask: 1 = Alt, 2 = Ctrl, 4 = Shift
param([string]$ReadyFile, [uint32]$Modifiers, [uint32]$VirtualKey)

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class FrameletHotkey {
  [StructLayout(LayoutKind.Sequential)]
  public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")]
  public static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
  public static void Run(string readyFile, uint modifiers, uint vk) {
    bool ok = RegisterHotKey(IntPtr.Zero, 1, modifiers | 0x4000u, vk); // MOD_NOREPEAT
    File.WriteAllText(readyFile, ok ? "ok" : "fail");
    if (!ok) return;
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
  }
}
"@

[FrameletHotkey]::Run($ReadyFile, $Modifiers, $VirtualKey)
