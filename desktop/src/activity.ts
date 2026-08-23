export interface ActivityDay { date: string; count: number }

/// Count-plus-noun strips read "1 pages" without this. Regular -s only; nothing here is irregular.
export const plural = (count: number, noun: string, many = `${noun}s`) => count === 1 ? noun : many;

export function activityDays(timestamps: string[], now = new Date()): ActivityDay[] {
  const valid = timestamps.map((value) => new Date(value)).filter((value) => !Number.isNaN(value.valueOf()));
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const counts = new Map<string, number>();
  const key = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  for (const value of valid) { const day = key(value); counts.set(day, (counts.get(day) ?? 0) + 1); }
  const days: ActivityDay[] = [];
  for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) { const date = key(day); days.push({ date, count: counts.get(date) ?? 0 }); }
  return days;
}

export function activityGrid(timestamps: string[], weeks: number, now = new Date()): { weeks: ActivityDay[][]; max: number } {
  const valid = timestamps.map((value) => new Date(value)).filter((value) => !Number.isNaN(value.valueOf()));
  const key = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  const counts = new Map<string, number>();
  for (const value of valid) { const day = key(value); counts.set(day, (counts.get(day) ?? 0) + 1); }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay()));
  const start = new Date(end);
  start.setDate(start.getDate() - (weeks - 1) * 7);
  const columns: ActivityDay[][] = [];
  for (let week = 0; week < weeks; week += 1) {
    const first = new Date(start);
    first.setDate(first.getDate() + week * 7);
    const column: ActivityDay[] = [];
    for (let day = 0; day < 7; day += 1) {
      const at = new Date(first);
      at.setDate(at.getDate() + day);
      column.push({ date: key(at), count: counts.get(key(at)) ?? 0 });
    }
    columns.push(column);
  }
  return { weeks: columns, max: Math.max(1, ...counts.values()) };
}
