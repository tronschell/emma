import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join(__dirname, "../../src/mobile.tsx"), "utf8");
const drawStart = source.indexOf("useEffect(() => {\n    const target = canvas.current;");
const drawEffect = source.slice(drawStart, source.indexOf("\n  }, [pairing]);", drawStart));

test("the QR runtime loads only when the pairing canvas is drawn", () => {
  assert.doesNotMatch(source, /^import .* from ["']qrcode["'];$/m);
  assert.equal((source.match(/import\(["']qrcode["']\)/g) ?? []).length, 1);
  assert.match(drawEffect, /import\(["']qrcode["']\)/);
});
