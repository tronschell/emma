import { useEffect, useState } from "react";
import { MACHINE_HISTORY, MACHINE_TICK_MS, type MachineSample } from "../shared/machine";
import type { WidgetOrientation } from "../shared/context-bar";

let history: MachineSample[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let sampling = false;
const listeners = new Set<(samples: MachineSample[]) => void>();

async function tick() {
  if (sampling) return;
  sampling = true;
  try {
    const sample = await window.emma.machineSample();
    history = [...history, sample].slice(-MACHINE_HISTORY);
    for (const listener of listeners) listener(history);
  } catch {
    return;
  } finally {
    sampling = false;
  }
}

export function useMachine(): MachineSample[] {
  const [samples, setSamples] = useState(history);
  useEffect(() => {
    listeners.add(setSamples);
    if (!timer) {
      void tick();
      timer = setInterval(() => void tick(), MACHINE_TICK_MS);
    }
    return () => {
      listeners.delete(setSamples);
      if (!listeners.size) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, []);
  return samples;
}

const share = (value: number) => `${Math.round(value * 100)}%`;

const sizeLabel = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes >= 10 * 1024 ** 2 ? 0 : 1)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${Math.round(bytes)}B`;
};

const traffic = (sample: MachineSample) => `${sizeLabel(sample.rxBytes)}/s ↓ ${sizeLabel(sample.txBytes)}/s ↑`;

interface Series {
  id: string;
  label: string;
  hue: string;
  read: (sample: MachineSample) => number;
  value: (sample: MachineSample) => string;
  title: (sample: MachineSample) => string;
}

const SERIES: Series[] = [
  { id: "cpu", label: "CPU", hue: "var(--teal)", read: (sample) => sample.cpu, value: (sample) => share(sample.cpu), title: (sample) => `${share(sample.cpu)} of every core on this Mac` },
  { id: "memory", label: "Memory", hue: "var(--violet)", read: (sample) => sample.memory, value: (sample) => share(sample.memory), title: (sample) => `${sizeLabel(sample.memoryUsedBytes)} of ${sizeLabel(sample.memoryTotalBytes)} — active, wired and compressed` },
  { id: "gpu", label: "GPU", hue: "var(--lime)", read: (sample) => sample.gpu ?? 0, value: (sample) => sample.gpu === null ? "—" : share(sample.gpu), title: (sample) => sample.gpu === null ? "This Mac reports no GPU utilisation" : `${share(sample.gpu)} device utilisation` },
  { id: "network", label: "Network", hue: "var(--blue)", read: (sample) => sample.rxBytes + sample.txBytes, value: (sample) => `${sizeLabel(sample.rxBytes + sample.txBytes)}/s`, title: traffic },
];

const peakOf = (series: Series, samples: MachineSample[]) => Math.max(...samples.map(series.read), series.id === "network" ? 64 * 1024 : 1);

const points = (series: Series, samples: MachineSample[], peak: number) =>
  samples.map((sample, index) => `${samples.length > 1 ? index / (samples.length - 1) * 100 : 0},${(1 - Math.min(1, series.read(sample) / peak)) * 24}`);

const HOLD = "Reading this Mac…";

export function MachineStats({ orientation }: { orientation: WidgetOrientation }) {
  const samples = useMachine();
  const latest = samples[samples.length - 1];
  return <section className="context-stats machine-stats" data-orientation={orientation}>
    <span className="machine-title">Machine · now</span>
    {latest ? <div className="agent-metrics">
      {SERIES.map((series) => <span key={series.id} title={series.title(latest)}>
        <b style={{ color: series.hue }}>{series.value(latest)}</b> {series.label.toLowerCase()}
      </span>)}
    </div> : <p className="machine-empty">{HOLD}</p>}
    {latest && <p className="machine-note">{sizeLabel(latest.memoryUsedBytes)} of {sizeLabel(latest.memoryTotalBytes)} · {traffic(latest)}</p>}
  </section>;
}

export function MachineGraph({ orientation }: { orientation: WidgetOrientation }) {
  const samples = useMachine();
  const latest = samples[samples.length - 1];
  return <section className="machine-graph" data-orientation={orientation}>
    <span>Machine · last {Math.max(1, samples.length)}s</span>
    {latest ? <ul>
      {SERIES.map((series) => {
        const peak = peakOf(series, samples);
        const line = points(series, samples, peak);
        return <li key={series.id} style={{ color: series.hue }} title={series.title(latest)}>
          <span>{series.label}</span><b>{series.value(latest)}</b>
          <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
            {line.length > 1 && <polygon points={`0,24 ${line.join(" ")} 100,24`} />}
            {line.length > 1 && <polyline points={line.join(" ")} />}
          </svg>
        </li>;
      })}
    </ul> : <p className="machine-empty">{HOLD}</p>}
  </section>;
}

const CELLS = 16;

export function MachineMeters({ orientation }: { orientation: WidgetOrientation }) {
  const samples = useMachine();
  const latest = samples[samples.length - 1];
  return <section className="machine-meters" data-orientation={orientation}>
    <span>Machine</span>
    {latest ? <ul>
      {SERIES.map((series) => {
        const moved = latest.rxBytes + latest.txBytes;
        const down = series.id === "network" ? Math.round(moved ? latest.rxBytes / moved * CELLS : 0) : 0;
        const filled = series.id === "network" ? CELLS : Math.round(Math.min(1, series.read(latest)) * CELLS);
        return <li key={series.id} style={{ color: series.hue }} title={series.title(latest)}>
          <span>{series.label}</span>
          <div className="machine-cells" role="img" aria-label={`${series.label} ${series.value(latest)}`}>
            {Array.from({ length: CELLS }, (_, index) => <i key={index} data-on={index < filled || undefined} data-half={series.id === "network" && index >= down || undefined} />)}
          </div>
          <b>{series.value(latest)}</b>
        </li>;
      })}
    </ul> : <p className="machine-empty">{HOLD}</p>}
  </section>;
}
