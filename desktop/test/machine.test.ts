import test from "node:test";
import assert from "node:assert/strict";
import { parseProbe } from "../main/machine";

const PROBE = `net 39768951532 34031605873
"Device Utilization %"=32
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    57537.
Pages active:                                1186837.
Pages inactive:                              1176859.
Pages speculative:                              8098.
Pages wired down:                             246992.
Pages purgeable:                               12614.
Pages stored in compressor:                  1085814.
Pages occupied by compressor:                 408651.
`;

test("a probe reads its counters, its GPU share and what memory is actually holding", () => {
  const reading = parseProbe(PROBE);
  assert.equal(reading.rx, 39768951532);
  assert.equal(reading.tx, 34031605873);
  assert.equal(reading.gpu, 0.32);
  assert.equal(reading.memoryUsedBytes, (1186837 + 246992 + 408651) * 16384);
});

test("a probe that answered nothing reads as zero rather than NaN", () => {
  assert.deepEqual(parseProbe(""), { rx: 0, tx: 0, gpu: null, memoryUsedBytes: 0 });
});
