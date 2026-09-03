export function Bars({ values, labels, className }: { values: number[]; labels: string[]; className: string }) {
  const peak = Math.max(1, ...values);
  return <div className={className} aria-hidden="true">
    {values.map((count, index) => <span key={labels[index]} title={`${labels[index]} · ${count}`}><i style={{ height: `${Math.round((count / peak) * 100)}%`, animationDelay: `${index * 14}ms` }} /></span>)}
  </div>;
}
