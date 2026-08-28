export type UsageRow = {
  id: string;
  name: string;
  source: string;
  days: Record<string, number>;
};

const DAY_MILLISECONDS = 86_400_000;

export function usageDay(at: Date) {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

export function recentDays(count: number, today = new Date()) {
  const end = today.getTime();
  return Array.from({ length: count }, (_, index) => usageDay(new Date(end - (count - 1 - index) * DAY_MILLISECONDS)));
}

export function rowTotal(row: UsageRow) {
  return Object.values(row.days).reduce((sum, count) => sum + count, 0);
}

export function rowSeries(row: UsageRow, days: string[]) {
  return days.map((day) => row.days[day] ?? 0);
}

export function usageSeries(rows: UsageRow[], days: string[]) {
  return days.map((day) => rows.reduce((sum, row) => sum + (row.days[day] ?? 0), 0));
}

export function lastUsed(row: UsageRow) {
  return Object.keys(row.days).sort().at(-1) ?? "";
}

export function byUse(rows: UsageRow[]) {
  return [...rows].sort((left, right) => rowTotal(right) - rowTotal(left) || left.name.localeCompare(right.name));
}
