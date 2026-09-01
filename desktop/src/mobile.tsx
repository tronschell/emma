import { useEffect, useRef, useState } from "react";
import { isPin, PIN_MAX_DIGITS, type PairingPayload } from "../shared/mobile-protocol";
import { day } from "./dates";
import { reasonText } from "./errors";
import { InfoDot } from "./icons";

type MobileDevice = { id: number; connected: boolean; lastSeen: number };
type MobileStatus = { devices: MobileDevice[]; listening: boolean; pairing: boolean; full: boolean; reason: string; name: string; addr: string };

const bridge = window.emma as typeof window.emma & {
  mobileStatus(): Promise<MobileStatus>;
  mobilePair(pin: string): Promise<PairingPayload>;
  mobileCancelPair(): Promise<MobileStatus>;
  mobileUnpair(id?: number): Promise<MobileStatus>;
  onMobileStatus(listener: (status: MobileStatus) => void): () => void;
};

const QR_PIXELS = 200;
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
  return <div className="settings-lines">
    {(error || status.reason) && <div className="local-model-error" role="alert">{error || status.reason}</div>}
    <section>
      <div>
        <div className="settings-head"><h3>PIN</h3><InfoDot>The pairing code carries the key that opens this computer, and it is on screen for two minutes. The PIN never appears in it, so a code read over your shoulder is not enough on its own. The phone is asked for it once, while pairing.</InfoDot></div>
        <p>4 to 12 digits. Choose one before pairing, and type it on the phone when it asks.</p>
        <label>PIN<input
          value={pin}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          disabled={locked || status.full || pairing !== null}
          maxLength={PIN_MAX_DIGITS}
          placeholder="••••"
          aria-label="Pairing PIN"
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
        /></label>
      </div>
      <a href="https://github.com/tronschell/emma-mobile" target="_blank" rel="noreferrer">Emma Mobile ↗</a>
    </section>
    <section>
      <div>
        <h3>Emma Mobile</h3>
        {status.devices.map((device) => <p key={device.id}>
          <strong className={device.connected ? "status-live" : "status-idle"}><i /> {device.connected ? "Connected" : `Disconnected · seen ${seen(device.lastSeen)}`}</strong>
          {" "}Paired {day(device.id)}.{" "}
          <button type="button" className="reset-data" disabled={locked} onClick={() => void unpair(device.id)}>{confirming === device.id ? "Remove for good" : "Remove"}</button>
        </p>)}
        {pairing && <strong className="status-live"><i /> Expires in {left}s</strong>}
        {pairing && <p>Scan this with Emma Mobile.</p>}
        {status.devices.length > 0 && status.addr && <p>Reachable at <code>{status.addr}</code>{status.listening || status.reason ? "" : " — not listening yet"}.</p>}
        {status.full && <p>Three devices are paired, which is the most Emma keeps. Remove one to pair another.</p>}
        {!ready && !status.full && <p>Choose a PIN above first.</p>}
        <p>Both devices must be on the same Tailscale network, or the same Wi-Fi. A paired phone sends messages to your threads, answers the tool permission prompts this computer would otherwise ask you, and runs git — staging, commits, push and pull. Pair only a phone you are holding.</p>
      </div>
      {pairing
        ? <canvas ref={canvas} role="img" aria-label="Pairing code for Emma Mobile" style={{ justifySelf: "start" }} />
        : <button type="button" style={{ justifySelf: "start" }} disabled={locked || !ready || status.full} onClick={() => void pair()}>Pair a phone</button>}
    </section>
  </div>;
}
