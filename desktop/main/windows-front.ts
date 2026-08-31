import { spawn } from "node:child_process";
import { terminateProcessTree, windowsPowerShellExecutable } from "./platform";

export type WindowsFrontPage = { application: string; window: string; url: string; title: string };
export type WindowsFrontContext = { front: WindowsFrontPage; browsers: WindowsFrontPage[] };

const MAX_OUTPUT = 32 * 1024;
const WINDOWS_FRONT_CONTEXT_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EmmaFrontWindow {
  public delegate bool EnumWindowsProc(IntPtr handle, IntPtr data);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder value, int length);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
}
"@
$handles = New-Object System.Collections.Generic.List[System.IntPtr]
$foreground = [EmmaFrontWindow]::GetForegroundWindow()
if ($foreground -ne [IntPtr]::Zero -and [EmmaFrontWindow]::IsWindowVisible($foreground)) { $handles.Add($foreground) }
[EmmaFrontWindow]::EnumWindows({ param($handle, $data) if ($handle -ne $foreground -and [EmmaFrontWindow]::IsWindowVisible($handle)) { $handles.Add($handle) }; return $true }, [IntPtr]::Zero) | Out-Null
$browserNames = @{
  chrome = "Google Chrome"
  chromium = "Chromium"
  brave = "Brave Browser"
  msedge = "Microsoft Edge"
  vivaldi = "Vivaldi"
  opera = "Opera"
  arc = "Arc"
}
function Get-WindowText([IntPtr] $handle) {
  $value = New-Object System.Text.StringBuilder 1024
  [void][EmmaFrontWindow]::GetWindowText($handle, $value, $value.Capacity)
  return $value.ToString()
}
function Get-Page([IntPtr] $handle, [string] $application, [string] $window) {
  $url = ""
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if ($null -ne $root) {
      $condition = New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList @([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
      $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
      foreach ($edit in $edits) {
        $candidate = $edit.GetCurrentPropertyValue([System.Windows.Automation.ValuePatternIdentifiers]::ValueProperty)
        if ($candidate -is [string] -and $candidate -match '^https?://') { $url = $candidate; break }
      }
    }
  } catch {}
  [pscustomobject]@{ application = $application; window = $window; url = $url; title = $window }
}
$rows = @()
foreach ($handle in $handles) {
  $processId = [uint32]0
  [void][EmmaFrontWindow]::GetWindowThreadProcessId($handle, [ref]$processId)
  if ($processId -eq 0) { continue }
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process) { continue }
  $processName = $process.ProcessName.ToLowerInvariant()
  $application = if ($browserNames.ContainsKey($processName)) { $browserNames[$processName] } else { $process.ProcessName }
  $window = Get-WindowText $handle
  $rows += if ($browserNames.ContainsKey($processName)) { Get-Page $handle $application $window } else { [pscustomobject]@{ application = $application; window = $window; url = ""; title = $window } }
  if ($rows.Count -ge 64) { break }
}
$front = if ($rows.Count -gt 0) { $rows[0] } else { [pscustomobject]@{ application = ""; window = ""; url = ""; title = "" } }
$browsers = @($rows | Where-Object { $_.url -or $browserNames.ContainsValue($_.application) })
[pscustomobject]@{ front = $front; browsers = $browsers } | ConvertTo-Json -Compress -Depth 4
`;

export function parseWindowsFrontContext(value: string): WindowsFrontContext {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Windows front window response");
  const raw = parsed as { front?: unknown; browsers?: unknown };
  const read = (entry: unknown): WindowsFrontPage => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid Windows front window entry");
    const item = entry as Record<string, unknown>;
    if (!["application", "window", "url", "title"].every((key) => typeof item[key] === "string")) throw new Error("Invalid Windows front window entry");
    const page = { application: item.application as string, window: item.window as string, url: item.url as string, title: item.title as string };
    if (page.application.length > 256 || page.window.length > 2048 || page.url.length > 4096 || page.title.length > 2048) throw new Error("Invalid Windows front window entry");
    return page;
  };
  if (!raw.front || !Array.isArray(raw.browsers) || raw.browsers.length > 64) throw new Error("Invalid Windows front window response");
  return { front: read(raw.front), browsers: raw.browsers.map(read) };
}

export function windowsFrontContext(): Promise<WindowsFrontContext> {
  return new Promise((resolve, reject) => {
    const child = spawn(windowsPowerShellExecutable(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_FRONT_CONTEXT_SCRIPT], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let failure = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid) terminateProcessTree(child.pid, "SIGTERM", false);
      reject(new Error("Emma could not inspect the front Windows application in time"));
    }, 5000);
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); if (output.length > MAX_OUTPUT && child.pid) terminateProcessTree(child.pid, "SIGTERM", false); });
    child.stderr.on("data", (data: Buffer) => { failure = `${failure}${data.toString()}`.slice(0, 512); });
    child.once("error", (error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(failure.trim() || "Emma could not inspect the front Windows application")); return; }
      try { resolve(parseWindowsFrontContext(output.trim())); } catch { reject(new Error("Emma received an invalid front Windows application response")); }
    });
  });
}
