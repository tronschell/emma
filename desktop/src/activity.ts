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
