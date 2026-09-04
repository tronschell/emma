export type Cell = string | number;
export type Sheet = { name: string; rows: Cell[][] };

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let round = 0; round < 8; round += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

const printable = (letter: string): boolean => {
  const code = letter.codePointAt(0) ?? 0;
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127 && (code & 0xfffe) !== 0xfffe);
};

export const plainText = (value: string): string => [...value].filter(printable).join("");

export const xmlText = (value: string): string => plainText(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

export function columnName(index: number): string {
  let name = "";
  for (let left = index; left >= 0; left = Math.floor(left / 26) - 1) name = String.fromCharCode(65 + (left % 26)) + name;
  return name;
}

export function sheetXml(rows: readonly Cell[][]): string {
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((cell, cellIndex) => {
      const reference = `${columnName(cellIndex)}${rowIndex + 1}`;
      if (typeof cell === "number" && Number.isFinite(cell)) return `<c r="${reference}"><v>${cell}</v></c>`;
      return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlText(String(cell))}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

const OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function parts(sheets: readonly Sheet[]): { name: string; text: string }[] {
  const numbered = sheets.map((sheet, index) => ({ sheet, index: index + 1 }));
  return [
    {
      name: "[Content_Types].xml",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${numbered.map(({ index }) => `<Override PartName="/xl/worksheets/sheet${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE}"><sheets>${numbered.map(({ sheet, index }) => `<sheet name="${xmlText(sheet.name)}" sheetId="${index}" r:id="rId${index}"/>`).join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${numbered.map(({ index }) => `<Relationship Id="rId${index}" Type="${OFFICE}/worksheet" Target="worksheets/sheet${index}.xml"/>`).join("")}</Relationships>`,
    },
    ...numbered.map(({ sheet, index }) => ({ name: `xl/worksheets/sheet${index}.xml`, text: sheetXml(sheet.rows) })),
  ];
}

const DOS_TIME = 0;
const DOS_DATE = 0x2821;
const UTF8_FLAG = 0x0800;

export function zipStored(files: readonly { name: string; text: string }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.text, "utf8");
    const sum = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(UTF8_FLAG, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(sum, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(UTF8_FLAG, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += head.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export const workbook = (sheets: readonly Sheet[]): Buffer => zipStored(parts(sheets));
