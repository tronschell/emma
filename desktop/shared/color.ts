/* Hex ⇄ HSV for the colour well. HSV is what a saturation square and a hue rule
   are, and hex is what the settings store keeps. */

/** HSV → #rrggbb. h in degrees, s and v in 0…1. */
export function hsvHex(h: number, s: number, v: number): string {
  const part = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255).toString(16).padStart(2, "0");
  };
  return `#${part(5)}${part(3)}${part(1)}`;
}

/** #rgb or #rrggbb → [h, s, v]. Anything unparseable reads as black. */
export function hexHsv(value: string): [number, number, number] {
  const body = value.replace("#", "");
  const full = body.length === 3 ? [...body].map((c) => c + c).join("") : body.slice(0, 6).padEnd(6, "0");
  const num = Number.parseInt(full, 16) || 0;
  const [r, g, b] = [(num >> 16) & 255, (num >> 8) & 255, num & 255].map((c) => c / 255);
  const max = Math.max(r, g, b), span = max - Math.min(r, g, b);
  const h = !span ? 0 : max === r ? ((g - b) / span + 6) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return [h * 60, max ? span / max : 0, max];
}
