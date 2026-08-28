import { useEffect, useRef, useState } from "react";
import { toCanvas } from "qrcode";
import { relayOrigin, type PairingPayload } from "../shared/mobile-protocol";
import { day } from "./dates";
import { reasonText } from "./errors";
import { InfoDot } from "./icons";

type MobileStatus = { paired: boolean; connected: boolean; name: string; lastSeen: number };

const bridge = window.emma as typeof window.emma & {
  mobileStatus(): Promise<MobileStatus>;
  mobilePair(relay: string): Promise<PairingPayload>;
  mobileCancelPair(): Promise<MobileStatus>;
  mobileUnpair(): Promise<MobileStatus>;
  onMobileStatus(listener: (status: MobileStatus) => void): () => void;
};

const QR_PIXELS = 200;

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

export function MobileSettings({ relay, onRelay, busy }: { relay: string; onRelay: (relay: string) => void; busy: boolean }) {
  const [status, setStatus] = useState<MobileStatus>({ paired: false, connected: false, name: "", lastSeen: 0 });
  const [pairing, setPairing] = useState<PairingPayload | null>(null);
  const [left, setLeft] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const showing = useRef(false);

  useEffect(() => {
    let live = true;
    const apply = (next: MobileStatus) => {
      if (!live) return;
      setStatus(next);
      if (next.paired && showing.current) {
        showing.current = false;
        setPairing(null);
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
    void toCanvas(target, JSON.stringify(pairing), { width: QR_PIXELS, margin: 2, color: { dark: tone("--bg"), light: tone("--text") } })
      .catch(() => { setPairing(null); setError("This Mac could not draw the pairing code."); });
  }, [pairing]);

  const pair = async () => {
    setError("");
    setWorking(true);
    try {
      const payload = await bridge.mobilePair(relay);
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

  const unpair = async () => {
    if (!confirming) { setConfirming(true); return; }
    setError("");
    setWorking(true);
    try {
      setStatus(await bridge.mobileUnpair());
      setConfirming(false);
    } catch (reason) {
      setError(reasonText(reason));
    } finally {
      setWorking(false);
    }
  };

  const locked = busy || working;
  const ready = relayOrigin(relay) !== "";
  return <div className="settings-lines">
    {error && <div className="local-model-error" role="alert">{error}</div>}
    <section>
      <div>
        <div className="settings-head"><h3>Relay</h3><InfoDot>Both devices dial out to it, so neither needs an open port, a VPN, or a domain. It only ever sees ciphertext: every frame is sealed end to end, and the relay holds no key that opens one. Deploy it once and every later pairing reuses it.</InfoDot></div>
        <p>Your own Cloudflare Worker, from <code>relay/</code> in the Emma Mobile repository. <code>npx wrangler login && npx wrangler deploy</code> prints the address.</p>
        <label>Address<input
          value={draft ?? relay}
          disabled={locked || status.paired}
          spellCheck={false}
          placeholder="wss://emma-relay.your-subdomain.workers.dev"
          aria-label="Relay address"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => { const value = draft; setDraft(null); if (value !== null && relayOrigin(value) !== relay) onRelay(relayOrigin(value)); }}
        /></label>
      </div>
      <a href="https://github.com/tronschell/emma-mobile" target="_blank" rel="noreferrer">Emma Mobile ↗</a>
    </section>
    <section>
      <div>
        <h3 style={{ overflowWrap: "anywhere" }}>{status.paired ? status.name : "Emma Mobile"}</h3>
        {status.paired && <strong className={status.connected ? "status-live" : "status-idle"}><i /> {status.connected ? "Connected" : `Disconnected · seen ${seen(status.lastSeen)}`}</strong>}
        {pairing && <strong className="status-live"><i /> Expires in {left}s</strong>}
        {pairing && <p>Scan this with Emma Mobile.</p>}
        {!ready && !status.paired && <p>Set a relay address above first.</p>}
        <p>A paired phone sends messages to your threads, answers the tool permission prompts this Mac would otherwise ask you, and runs git — staging, commits, push and pull. Pair only a phone you are holding.</p>
      </div>
      {pairing
        ? <canvas ref={canvas} role="img" aria-label="Pairing code for Emma Mobile" style={{ justifySelf: "start" }} />
        : status.paired
          ? <button type="button" className="reset-data" disabled={locked} onClick={() => void unpair()}>{confirming ? "Unpair for good" : "Unpair"}</button>
          : <button type="button" style={{ justifySelf: "start" }} disabled={locked || !ready} onClick={() => void pair()}>Pair a phone</button>}
    </section>
  </div>;
}
