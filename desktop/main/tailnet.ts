import { networkInterfaces } from "node:os";

// 100.64.0.0/10 — the CGNAT range Tailscale assigns node addresses from.
const TAILNET = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

export type Hosts = { tailnet: string[]; lan: string[] };

/** Every IPv4 address this Mac can be reached on, split by whether Tailscale owns it. */
export function hosts(): Hosts {
  const tailnet: string[] = [];
  const lan: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (TAILNET.test(address.address)) tailnet.push(address.address);
      else lan.push(address.address);
    }
  }
  return { tailnet: tailnet.sort(), lan: lan.sort() };
}

/** The address to pair on: the tailnet if Tailscale is up, otherwise the LAN. */
export function preferredHost(): string | undefined {
  const found = hosts();
  return found.tailnet[0] ?? found.lan[0];
}

export function isTailnet(host: string): boolean {
  return TAILNET.test(host);
}
