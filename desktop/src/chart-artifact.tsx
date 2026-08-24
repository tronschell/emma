import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/* Its own module so recharts stays out of the overlay's bundle: the document
   loads it only when a page actually carries a chart block. */

// Same reading as the agent dashboard: tokens, never pasted hex.
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const chart = { grid: token("--border"), axis: token("--text-3"), tip: token("--surface-2"), tipBorder: token("--border-strong"), bar: token("--orange"), line: token("--teal") };

export default function ChartArtifact({ kind, labels, values, caption }: { kind: string; labels: string[]; values: number[]; caption: string }) {
  const data = labels.slice(0, 12).map((label, index) => ({ label, value: Number.isFinite(values[index]) ? values[index] : 0 }));
  const axes = <>
    <CartesianGrid stroke={chart.grid} vertical={false} />
    <XAxis dataKey="label" stroke={chart.axis} fontSize={10} interval={0} />
    <YAxis stroke={chart.axis} fontSize={10} width={32} />
    <Tooltip contentStyle={{ background: chart.tip, border: `1px solid ${chart.tipBorder}`, fontSize: 11 }} />
  </>;
  return <figure className="artifact-chart">
    <ResponsiveContainer width="100%" height={220}>
      {kind === "line" ? <LineChart accessibilityLayer data={data} margin={{ left: 0, right: 8, top: 8 }}>{axes}<Line type="monotone" dataKey="value" name={caption} stroke={chart.line} dot={false} /></LineChart>
        : kind === "area" ? <AreaChart accessibilityLayer data={data} margin={{ left: 0, right: 8, top: 8 }}>{axes}<Area type="monotone" dataKey="value" name={caption} stroke={chart.line} fill={`${chart.line}33`} /></AreaChart>
          : <BarChart accessibilityLayer data={data} margin={{ left: 0, right: 8, top: 8 }}>{axes}<Bar dataKey="value" name={caption} fill={chart.bar} radius={0} /></BarChart>}
    </ResponsiveContainer>
    {caption && <figcaption>{caption}</figcaption>}
  </figure>;
}
