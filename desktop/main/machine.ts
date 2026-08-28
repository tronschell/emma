import { execFile } from "node:child_process";
import { cpus, totalmem } from "node:os";
import type { MachineSample } from "../shared/machine";

const PROBE = `netstat -ib | awk '/Link#/ && $1 !~ /^lo/ {i += $(NF - 4); o += $(NF - 1)} END {printf "net %d %d\\n", i, o}'
ioreg -r -d 1 -w 0 -c IOAccelerator | grep -om1 '"Device Utilization %"=[0-9]*'
vm_stat`;
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
  const pageSize = Number(/page size of (\d+)/.exec(text)?.[1] ?? 0);
  const gpu = /"Device Utilization %"=(\d+)/.exec(text);
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

const probe = () => new Promise<string>((resolve) => {
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
  return {
    cpu: before && spent > 0 ? Math.min(1, Math.max(0, 1 - (ticks.idle - before.idle) / spent)) : 0,
    memory: memoryTotalBytes ? Math.min(1, reading.memoryUsedBytes / memoryTotalBytes) : 0,
    memoryUsedBytes: reading.memoryUsedBytes,
    memoryTotalBytes,
    gpu: reading.gpu,
    rxBytes: before ? Math.max(0, (reading.rx - before.rx) / seconds) : 0,
    txBytes: before ? Math.max(0, (reading.tx - before.tx) / seconds) : 0,
  };
}
