import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";

const TAILNET = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const SELF_ASSIGNED = /^169\.254\./;
const TAILSCALE = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
  "tailscale",
];
const TAILSCALE_MS = 2_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DNS_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export type Hosts = { tailnet: string[]; lan: string[] };

export function hosts(): Hosts {
  const tailnet: string[] = [];
  const lan: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (TAILNET.test(address.address)) tailnet.push(address.address);
      else if (!SELF_ASSIGNED.test(address.address)) lan.push(address.address);
    }
  }
  return { tailnet: tailnet.sort(), lan: lan.sort() };
}

const here = (): string[] => {
  const found = hosts();
  return [...found.tailnet, ...found.lan];
};

export async function addressesFor(host: string): Promise<string[]> {
  const mine = here();
  try {
    const found = await lookup(host, { all: true, family: 4 });
    return found.map((entry) => entry.address).filter((address) => mine.includes(address)).sort();
  } catch {
    return [];
  }
}

const askTailscale = (binary: string) => new Promise<string>((resolve) => {
  execFile(binary, ["status", "--json"], { timeout: TAILSCALE_MS, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout));
});

async function magicDns(): Promise<string | undefined> {
  for (const binary of TAILSCALE) {
    const answer = await askTailscale(binary);
    if (!answer) continue;
    let name = "";
    try {
      const self = (JSON.parse(answer) as { Self?: { DNSName?: unknown } }).Self;
      if (typeof self?.DNSName === "string") name = self.DNSName.replace(/\.+$/, "").toLowerCase();
    } catch {
      return undefined;
    }
    return DNS_NAME.test(name) ? name : undefined;
  }
  return undefined;
}

export async function pairingHost(): Promise<string | undefined> {
  const mine = here();
  if (!mine.length) return undefined;
  if (hosts().tailnet.length) {
    const magic = await magicDns();
    if (magic && (await addressesFor(magic)).length) return magic;
  }
  return mine[0];
}
