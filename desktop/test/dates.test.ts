import assert from "node:assert/strict";
import test from "node:test";

import { zoned } from "../src/dates";

test("zoned reuses one formatter while the zone holds", () => {
  const built: string[] = [];
  const real = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function (locale?: string, options?: Intl.DateTimeFormatOptions) {
    built.push("built");
    return new real(locale, options);
  } as unknown as typeof Intl.DateTimeFormat;
  try {
    const format = zoned({ hour: "numeric", minute: "2-digit" });
    format(new Date("2026-08-23T18:00:00Z"));
    format(new Date("2026-01-02T09:30:00Z"));
    format(new Date("2026-06-11T22:15:00Z"));
    assert.equal(built.length, 1);
  } finally {
    Intl.DateTimeFormat = real;
  }
});

test("zoned rebuilds when the offset moves", () => {
  const built: string[] = [];
  const realFormat = Intl.DateTimeFormat;
  const realOffset = Date.prototype.getTimezoneOffset;
  let offset = 240;
  Intl.DateTimeFormat = function (locale?: string, options?: Intl.DateTimeFormatOptions) {
    built.push("built");
    return new realFormat(locale, options);
  } as unknown as typeof Intl.DateTimeFormat;
  Date.prototype.getTimezoneOffset = function () { return offset; };
  try {
    const format = zoned({ hour: "numeric", minute: "2-digit" });
    format(new Date("2026-08-23T18:00:00Z"));
    format(new Date("2026-08-23T19:00:00Z"));
    assert.equal(built.length, 1);
    offset = -540;
    format(new Date("2026-08-23T20:00:00Z"));
    assert.equal(built.length, 2);
    format(new Date("2026-08-23T21:00:00Z"));
    assert.equal(built.length, 2);
  } finally {
    Intl.DateTimeFormat = realFormat;
    Date.prototype.getTimezoneOffset = realOffset;
  }
});
