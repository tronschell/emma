export type Cell = string | number;

function csvCell(value: Cell): string {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: readonly Cell[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
