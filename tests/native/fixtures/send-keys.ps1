# Presses a key combination with the Win32 SendInput API (real, OS-level keyboard input).
# Usage: powershell -File send-keys.ps1 ctrl shift 3     (modifiers first, the key last)
# Only ever used by tests/native to trigger FrameCapt's own global shortcuts: the caller first checks
# that FrameCapt registered the combination, so the keys never reach another application.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Keys)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FrameCaptKeys {
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit, Size = 40)]
  public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  public static uint Send(ushort vk, bool up) {
    INPUT[] inputs = new INPUT[1];
    inputs[0].type = 1; // INPUT_KEYBOARD
    inputs[0].ki.wVk = vk;
    inputs[0].ki.dwFlags = up ? 2u : 0u; // KEYEVENTF_KEYUP
    return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@

function Get-VirtualKey([string]$name) {
  switch -Regex ($name.ToLowerInvariant()) {
    '^ctrl$' { return 0x11 }
    '^shift$' { return 0x10 }
    '^alt$' { return 0x12 }
    '^[0-9]$' { return 0x30 + [int]$name }
    '^[a-z]$' { return [int][char]$name.ToUpperInvariant() }
    '^f([1-9]|1[0-2])$' { return 0x70 + ([int]$Matches[1] - 1) }
    default { throw "Unsupported key: $name" }
  }
}

$codes = @($Keys | ForEach-Object { Get-VirtualKey $_ })
foreach ($code in $codes) {
  if ([FrameCaptKeys]::Send([uint16]$code, $false) -ne 1) { throw "SendInput failed (key down)" }
  Start-Sleep -Milliseconds 30
}
Start-Sleep -Milliseconds 60
[array]::Reverse($codes)
foreach ($code in $codes) {
  if ([FrameCaptKeys]::Send([uint16]$code, $true) -ne 1) { throw "SendInput failed (key up)" }
  Start-Sleep -Milliseconds 30
}
