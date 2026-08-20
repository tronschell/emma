export interface ActivityDay { date: string; count: number }

export function activityDays(timestamps: string[], now = new Date()): ActivityDay[] {
  const valid = timestamps.map((value) => new Date(value)).filter((value) => !Number.isNaN(value.valueOf()));
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  end.setDate(end.getDate() + (6 - end.getDay()));
  const first = valid.length ? new Date(Math.min(...valid.map(Number))) : now;
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  start.setDate(start.getDate() - start.getDay());
  const counts = new Map<string, number>();
  const key = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  for (const value of valid) { const day = key(value); counts.set(day, (counts.get(day) ?? 0) + 1); }
  const days: ActivityDay[] = [];
  for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) { const date = key(day); days.push({ date, count: counts.get(date) ?? 0 }); }
  return days;
}
