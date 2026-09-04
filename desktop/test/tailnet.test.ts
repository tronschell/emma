import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { hosts } from "../main/tailnet";

test("hosts sorts tailnet and LAN addresses while excluding internal, IPv6 and self-assigned addresses", (t) => {
  const addresses = [
    "100.128.0.1", "100.127.255.255", "192.168.1.5", "100.100.100.100",
    "100.64.0.0", "100.63.255.255", "169.254.1.2", "10.0.0.1",
  ];
  t.mock.method(os, "networkInterfaces", () => ({
    absent: undefined,
    external: addresses.map((address) => ({ address, family: "IPv4", internal: false })),
    loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    ipv6: [{ address: "::1", family: "IPv6", internal: false }],
  }));
  assert.deepEqual(hosts(), {
    tailnet: ["100.100.100.100", "100.127.255.255", "100.64.0.0"],
    lan: ["10.0.0.1", "100.128.0.1", "100.63.255.255", "192.168.1.5"],
  });
});
