import test from "node:test";
import assert from "node:assert/strict";
import { hosts, isTailnet, preferredHost } from "../main/tailnet";

test("the CGNAT range Tailscale hands out is recognised, and its neighbours are not", () => {
  for (const inside of ["100.64.0.0", "100.64.0.1", "100.100.100.100", "100.127.255.255", "100.99.0.1"]) {
    assert.equal(isTailnet(inside), true, `${inside} is inside 100.64.0.0/10`);
  }
  for (const outside of ["100.63.255.255", "100.128.0.1", "100.200.0.1", "10.0.0.1", "192.168.1.5", "1.100.64.1"]) {
    assert.equal(isTailnet(outside), false, `${outside} is outside 100.64.0.0/10`);
  }
});

test("this machine's addresses split into tailnet and LAN, and a tailnet address wins", () => {
  const found = hosts();
  assert.ok(Array.isArray(found.tailnet) && Array.isArray(found.lan));
  assert.ok(found.tailnet.every(isTailnet));
  assert.ok(found.lan.every((address) => !isTailnet(address)));
  assert.ok(!found.lan.includes("127.0.0.1"), "loopback is not an address a phone can reach");
  const preferred = preferredHost();
  if (found.tailnet.length) assert.equal(preferred, found.tailnet[0]);
  else assert.equal(preferred, found.lan[0]);
});
