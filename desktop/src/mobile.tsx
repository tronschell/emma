import { useEffect, useRef, useState } from "react";
import { isPin, PIN_MAX_DIGITS, type PairingPayload } from "../shared/mobile-protocol";
import { day } from "./dates";
import { reasonText } from "./errors";

type MobileDevice = { id: number; connected: boolean; lastSeen: number };
type MobileStatus = { devices: MobileDevice[]; listening: boolean; pairing: boolean; full: boolean; reason: string; name: string; addr: string; threads?: string[]; activeAt?: number };

const bridge = window.emma as typeof window.emma & {
  mobileStatus(): Promise<MobileStatus>;
  mobilePair(pin: string): Promise<PairingPayload>;
  mobileCancelPair(): Promise<MobileStatus>;
  mobileUnpair(id?: number): Promise<MobileStatus>;
  onMobileStatus(listener: (status: MobileStatus) => void): () => void;
};

const QR_PIXELS = 200;
const ACTIVE_MS = 1500;

export function usePhone() {
  const [status, setStatus] = useState<MobileStatus>(EMPTY);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const apply = (next: MobileStatus) => { setStatus(next); if (next.activeAt && Date.now() - next.activeAt < ACTIVE_MS) setBusy(true); };
    bridge.mobileStatus().then(apply).catch(() => undefined);
    return bridge.onMobileStatus(apply);
  }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => setBusy(false), ACTIVE_MS);
    return () => clearTimeout(timer);
  }, [busy]);
  const state = status.devices.length === 0 ? "none" : busy ? "busy" : status.devices.some((device) => device.connected) ? "on" : "away";
  return { state, threads: status.threads ?? [], devices: status.devices };
}

const PHONE_TITLES: Record<string, string> = { none: "No phone paired", on: "Phone connected", away: "Phone paired, not connected", busy: "Phone sending" };

const phoneBody = <><rect x="4.6" y="1.8" width="6.8" height="12.4" rx="1.4" /><path d="M7.2 12h1.6" /></>;

export function PhoneMark({ state, disabled, onClick }: { state: string; disabled?: boolean; onClick: () => void }) {
  const title = PHONE_TITLES[state] ?? state;
  return <button type="button" className="nav-settings nav-phone" data-state={state} title={title} aria-label={title} disabled={disabled} onClick={onClick}>
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g transform="translate(-1.6 0)">{phoneBody}</g>
      <path className="arc" d="M12.6 6.3a2.4 2.4 0 0 1 0 3.4" /><path className="arc arc-far" d="M14.2 4.6a4.8 4.8 0 0 1 0 6.8" />
    </svg>
  </button>;
}
const EMPTY: MobileStatus = { devices: [], listening: false, pairing: false, full: false, reason: "", name: "", addr: "" };

const tone = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const remaining = (payload: PairingPayload) => Math.max(0, Math.round((payload.exp - Date.now()) / 1000));

const seen = (at: number) => {
  const ms = Date.now() - at;
  if (!at || ms < 0) return "never";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return day(at);
};

export function MobileSettings({ busy }: { busy: boolean }) {
  const [status, setStatus] = useState<MobileStatus>(EMPTY);
  const [pairing, setPairing] = useState<PairingPayload | null>(null);
  const [left, setLeft] = useState(0);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [pin, setPin] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const showing = useRef(false);
  const before = useRef(0);

  useEffect(() => {
    let live = true;
    const apply = (next: MobileStatus) => {
      if (!live) return;
      setStatus(next);
      if (showing.current && !next.pairing) {
        showing.current = false;
        setPairing(null);
        if (next.devices.length <= before.current) setError("That pairing ended before a phone finished it.");
      }
    };
    bridge.mobileStatus().then(apply).catch((reason: unknown) => { if (live) setError(reasonText(reason)); });
    const off = bridge.onMobileStatus(apply);
    return () => {
      live = false;
      off();
      if (showing.current) {
        showing.current = false;
        void bridge.mobileCancelPair().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => {
      const seconds = remaining(pairing);
      setLeft(seconds);
      if (seconds) return;
      showing.current = false;
      setPairing(null);
      void bridge.mobileCancelPair().catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  useEffect(() => {
    const target = canvas.current;
    if (!pairing || !target) return;
    let live = true;
    void import("qrcode")
      .then(({ toCanvas }) => {
        if (!live) return;
        return toCanvas(target, JSON.stringify(pairing), { width: QR_PIXELS, margin: 2, color: { dark: tone("--bg"), light: tone("--text") } });
      })
      .catch(() => {
        if (!live) return;
        setPairing(null);
        setError("This computer could not draw the pairing code.");
      });
    return () => { live = false; };
  }, [pairing]);

  const pair = async () => {
    setError("");
    setWorking(true);
    try {
      before.current = status.devices.length;
      const payload = await bridge.mobilePair(pin);
      const seconds = remaining(payload);
      if (!seconds) throw new Error("The pairing code expired before it could be shown.");
      showing.current = true;
      setLeft(seconds);
      setPairing(payload);
    } catch (reason) {
      setPairing(null);
      setError(reasonText(reason));
      void bridge.mobileCancelPair().catch(() => undefined);
    } finally {
      setWorking(false);
    }
  };

  const unpair = async (id: number) => {
    if (confirming !== id) { setConfirming(id); return; }
    setError("");
    setWorking(true);
    try {
      setStatus(await bridge.mobileUnpair(id));
      setConfirming(null);
    } catch (reason) {
      setError(reasonText(reason));
    } finally {
      setWorking(false);
    }
  };

  const locked = busy || working;
  const ready = isPin(pin);
  return <div className="mobile-settings">
    <header className="settings-intro">
      <div><h3>Emma, from your phone</h3><p>Continue threads, answer approval requests, and work with git from Emma Mobile.</p></div>
      <a href="https://github.com/tronschell/emma-mobile" target="_blank" rel="noreferrer">Get Emma Mobile ↗</a>
    </header>
    {(error || status.reason) && <p className="local-model-error" role="alert">{error || status.reason}</p>}
    {status.devices.length > 0 && <section className="mobile-devices" aria-labelledby="mobile-devices-title">
      <header><h3 id="mobile-devices-title">Paired phones</h3><span className="settings-count">{status.devices.length} of 3</span></header>
      {status.devices.map((device, index) => <div className="mobile-device" key={device.id}>
        <div><h4>Phone {index + 1}</h4><p>Paired {day(device.id)}{!device.connected && ` · Last seen ${seen(device.lastSeen)}`}</p></div>
        <span className="permission-state" data-granted={device.connected}>{device.connected ? "Connected" : "Offline"}</span>
        <button type="button" className="reset-data" data-armed={confirming === device.id} aria-label={`${confirming === device.id ? "Confirm removal of" : "Remove"} phone ${index + 1}`} disabled={locked} onClick={() => void unpair(device.id)}>{confirming === device.id ? "Confirm removal" : "Remove"}</button>
      </div>)}
    </section>}
    <section className="mobile-pairing" aria-labelledby="mobile-pairing-title">
      <div className="mobile-pairing-heading"><h3 id="mobile-pairing-title">{pairing ? "Scan to connect" : status.devices.length ? "Pair another phone" : "Pair your first phone"}</h3><span className="settings-count">{pairing ? "Step 2 of 2" : status.full ? "Device limit reached" : "Step 1 of 2"}</span></div>
      {status.full && !pairing ? <p>All three device slots are in use. Remove a phone above to pair another.</p> : pairing ? <div className="mobile-scan">
        <canvas ref={canvas} role="img" aria-label="Pairing code for Emma Mobile" />
        <div><p>Open Emma Mobile and scan this code. Enter the PIN you just chose when the phone asks.</p><span className="mobile-expiry">Expires in {left}s</span><p>Keep this code private. Pair only a phone you are holding.</p></div>
      </div> : <form className="mobile-pair-form" onSubmit={(event) => { event.preventDefault(); if (ready && !locked && !status.full) void pair(); }}>
        <p>Keep both devices on the same Wi-Fi or Tailscale network. Choose a PIN, then scan the code on your phone.</p>
        <div className="mobile-pair-controls"><label htmlFor="mobile-pair-pin">Pairing PIN<input
          id="mobile-pair-pin"
          value={pin}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          disabled={locked}
          maxLength={PIN_MAX_DIGITS}
          placeholder="4–12 digits"
          aria-describedby="mobile-pin-help"
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
        /></label><button className="save-settings" disabled={locked || !ready}>{working ? "Preparing code…" : "Show pairing code"}</button></div>
        <p id="mobile-pin-help" className="mobile-hint">Enter this PIN once on your phone. It stays out of the QR code.</p>
      </form>}
    </section>
    <details className="mobile-details"><summary>Connection & security</summary><div>
      <p>A paired phone can send messages, answer tool approvals, and stage, commit, push, or pull code on this computer.</p>
      <p>Pair only a phone you are holding. The QR code expires after two minutes; the PIN is required separately.</p>
      {status.devices.length > 0 && status.addr && <p>Reachable at <code>{status.addr}</code>{status.listening || status.reason ? "" : " — not listening yet"}.</p>}
    </div></details>
  </div>;
}
