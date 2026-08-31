import { execFile } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";
import type { MachineSample } from "../shared/machine";
import { findExecutable, isWindows, windowsPowerShellExecutable } from "./platform";

const PROBE = `netstat -ib | awk '/Link#/ && $1 !~ /^lo/ {i += $(NF - 4); o += $(NF - 1)} END {printf "net %d %d\\n", i, o}'
ioreg -r -d 1 -w 0 -c IOAccelerator | grep -om1 '"Device Utilization %"=[0-9]*'
vm_stat`;
const WINDOWS_PROBE = "$ErrorActionPreference='SilentlyContinue'; $stats=Get-NetAdapterStatistics; $rx=($stats | Measure-Object -Property ReceivedBytes -Sum).Sum; $tx=($stats | Measure-Object -Property SentBytes -Sum).Sum; $os=Get-CimInstance Win32_OperatingSystem; $total=[int64]$os.TotalVisibleMemorySize*1024; $used=$total-[int64]$os.FreePhysicalMemory*1024; $samples=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples; $gpu=if($samples){[math]::Round(($samples | Measure-Object -Property CookedValue -Sum).Sum)}else{-1}; 'win {0} {1} {2} {3} {4}' -f [int64]$rx,[int64]$tx,[int64]$used,$total,[int]$gpu";
const TIMEOUT_MS = 4_000;
const MAX_BUFFER_BYTES = 256 * 1024;

export interface MachineProbe {
  rx: number;
  tx: number;
  gpu: number | null;
  memoryUsedBytes: number;
}

const pages = (text: string, label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);

export function parseProbe(text: string): MachineProbe {
  const net = /^net (\d+) (\d+)$/m.exec(text);
  const windows = /^win (\d+) (\d+) (\d+) (\d+) (-?\d+)$/m.exec(text);
  const pageSize = Number(/page size of (\d+)/.exec(text)?.[1] ?? 0);
  const gpu = /"Device Utilization %"=(\d+)/.exec(text);
  if (windows) return {
    rx: Number(windows[1]),
    tx: Number(windows[2]),
    gpu: Number(windows[5]) >= 0 ? Math.min(1, Number(windows[5]) / 100) : null,
    memoryUsedBytes: Number(windows[3]),
  };
  return {
    rx: Number(net?.[1] ?? 0),
    tx: Number(net?.[2] ?? 0),
    gpu: gpu ? Math.min(1, Number(gpu[1]) / 100) : null,
    memoryUsedBytes: (pages(text, "Pages active") + pages(text, "Pages wired down") + pages(text, "Pages occupied by compressor")) * pageSize,
  };
}

function cpuTicks(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const core of cpus()) {
    idle += core.times.idle;
    total += core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq;
  }
  return { idle, total };
}

const powershellProbe = (binary: string) => new Promise<string>((resolve) => {
  execFile(binary, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_PROBE], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true }, (error, stdout) => resolve(error && !stdout ? "" : stdout));
});

const probe = () => isWindows
  ? powershellProbe(windowsPowerShellExecutable()).then((value) => value || findExecutable("pwsh.exe").then((binary) => binary ? powershellProbe(binary) : ""))
  : new Promise<string>((resolve) => {
    execFile("/bin/sh", ["-c", PROBE], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES }, (error, stdout) => resolve(error && !stdout ? "" : stdout));
  });

let previous: { at: number; idle: number; total: number; rx: number; tx: number } | undefined;

export async function machineSample(): Promise<MachineSample> {
  const reading = parseProbe(await probe());
  const ticks = cpuTicks();
  const at = Date.now();
  const before = previous;
  previous = { at, idle: ticks.idle, total: ticks.total, rx: reading.rx, tx: reading.tx };
  const seconds = before ? Math.max(0.1, (at - before.at) / 1_000) : 0;
  const spent = before ? ticks.total - before.total : 0;
  const memoryTotalBytes = totalmem();
  const memoryUsedBytes = reading.memoryUsedBytes || Math.max(0, memoryTotalBytes - freemem());
  return {
    cpu: before && spent > 0 ? Math.min(1, Math.max(0, 1 - (ticks.idle - before.idle) / spent)) : 0,
    memory: memoryTotalBytes ? Math.min(1, memoryUsedBytes / memoryTotalBytes) : 0,
    memoryUsedBytes,
    memoryTotalBytes,
    gpu: reading.gpu,
    rxBytes: before ? Math.max(0, (reading.rx - before.rx) / seconds) : 0,
    txBytes: before ? Math.max(0, (reading.tx - before.tx) / seconds) : 0,
  };
}
