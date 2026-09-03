import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";

// 100.64.0.0/10 — the CGNAT range Tailscale assigns node addresses from.
const TAILNET = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
// 169.254.0.0/16 — what an interface hands itself when there is no DHCP. Nothing is
// reachable there, and it sorts ahead of every real LAN address.
const SELF_ASSIGNED = /^169\.254\./;
/** Where the Tailscale CLI lives: the Mac App Store build, Homebrew, Windows, then $PATH. */
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

/** Every IPv4 address this Mac can be reached on, split by whether Tailscale owns it. */
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

/** Every address a phone could dial this Mac on right now. */
const here = (): string[] => {
  const found = hosts();
  return [...found.tailnet, ...found.lan];
};

/** The IPv4 address to pair on: the tailnet if Tailscale is up, otherwise the LAN. */
export function preferredHost(): string | undefined {
  const found = hosts();
  return found.tailnet[0] ?? found.lan[0];
}

/**
 * The addresses of this Mac that `host` points at right now. Empty when the name has
 * moved on to another machine, or resolves to nothing at all — which is the only thing
 * that makes a pairing unreachable, since an address change on its own no longer does.
 * An IP literal answers with itself, so a pairing made before names still works.
 */
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

/** This Mac's MagicDNS name, if Tailscale is running and MagicDNS is on. */
async function magicDns(): Promise<string | undefined> {
  for (const binary of TAILSCALE) {
    const answer = await askTailscale(binary);
    if (!answer) continue;
    let name = "";
    try {
      const self = (JSON.parse(answer) as { Self?: { DNSName?: unknown } }).Self;
      if (typeof self?.DNSName === "string") name = self.DNSName.replace(/\.+$/, "").toLowerCase();
    } catch {
      // Not the status JSON at all; another copy of the CLI will not answer better.
      return undefined;
    }
    // MagicDNS off reports a bare name or nothing, and neither of those resolves.
    return DNS_NAME.test(name) ? name : undefined;
  }
  return undefined;
}

/**
 * The host to put in the QR: a MagicDNS name when Tailscale is up, so the pairing
 * survives this Mac changing address, and this Mac's own address otherwise. An mDNS
 * name is never offered — nothing authenticates one, so whoever answers the query
 * first collects the auth token the phone offers before anything is mutually
 * authenticated. MagicDNS is authenticated by the tailnet, so it stays.
 */
export async function pairingHost(): Promise<string | undefined> {
  const mine = here();
  if (!mine.length) return undefined;
  if (hosts().tailnet.length) {
    const magic = await magicDns();
    // Checked before it is offered, so a Mac with MagicDNS off still pairs on an address.
    if (magic && (await addressesFor(magic)).length) return magic;
  }
  return mine[0];
}

export function isTailnet(host: string): boolean {
  return TAILNET.test(host);
}
