export interface MachineSample {
  cpu: number;
  memory: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  gpu: number | null;
  rxBytes: number;
  txBytes: number;
}

export const MACHINE_TICK_MS = 1_000;
export const MACHINE_HISTORY = 60;
