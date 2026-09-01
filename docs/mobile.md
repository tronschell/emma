# Mobile

A paired iPhone drives the same threads this computer does: it sends messages, reads
the live run, answers the tool permission prompts Emma would otherwise put in
front of you, and runs git. The phone app is a separate repository —
[tronschell/emma-mobile](https://github.com/tronschell/emma-mobile) — and it
talks to Emma **directly**, over your own network. There is no relay, no
Worker to deploy, no account to create, and no traffic through anyone else.

Two things have to be true before a phone can pair:

1. Emma Mobile is installed on the phone.
2. Both devices are on a network that can reach each other — your
   [Tailscale](https://tailscale.com) tailnet if you have one, the same Wi-Fi
   if you do not.

## The address

Emma listens on port **47823** and pairs on whichever of this Mac's addresses a
phone can actually reach, chosen by [`tailnet.ts`](../desktop/main/tailnet.ts):

1. A **Tailscale address** — anything in `100.64.0.0/10`, the CGNAT range
   Tailscale hands its nodes. This is what makes the pairing work from anywhere:
   install Tailscale on the Mac and the phone, sign both into the same account,
   and the address stays valid on cellular, at a hotel, behind carrier NAT.
   Tailscale does the NAT traversal; Emma never sees it and writes no code for
   it.
2. Otherwise **the LAN address**, which works while both devices are on the same
   Wi-Fi and stops working when you leave.

Loopback and internal interfaces are skipped — a phone cannot dial them. With no
address at all, pairing fails with `This Mac has no Tailscale or local network
address to pair on.`

Nothing about Tailscale is required, configured, or automated by Emma. It is not
bundled, not shelled out to, not detected beyond reading the interface list. If
a `100.x` address is there Emma uses it; if it is not, Emma uses the LAN. **Do
not use Tailscale Funnel** — it publishes the port to the open internet, which
is exactly what this design avoids.

The socket is bound to that one address, not to `0.0.0.0`. Joining a coffee shop
Wi-Fi does not open the port on it.

## Getting the app onto a phone

**There is no TestFlight or App Store build yet.** Today the only way onto a
phone is to build it yourself, which needs a Mac with Xcode, Node, and an Apple
ID signed into Xcode.

```sh
git clone https://github.com/tronschell/emma-mobile
cd emma-mobile
npm install
npx expo run:ios --device
```

Expo Go cannot run it: `llama.rn`, `expo-live-activity`, and `expo-camera` are
native modules, so the build is a real one. Pick your phone when prompted and
pick your own Apple team when Xcode asks — `app.config.js` reads
`EMMA_IOS_TEAM_ID` and `EMMA_IOS_BUNDLE_ID` if you would rather set them once:

```sh
EMMA_IOS_TEAM_ID=XXXXXXXXXX npx expo run:ios --device
```

A build signed with a free Apple ID **stops launching after seven days** and has
to be rebuilt. A paid Apple Developer account raises that to a year, and is what
a TestFlight build would need.

## Pairing

Set a **PIN** in **Settings → Mobile**, hit **Pair a phone**, then **Pair** in
Emma Mobile and hold the camera over the code. The phone asks for the PIN; type
it and the pairing is done.

What happens behind the sheet, in [`bridge.ts`](../desktop/main/bridge.ts):

1. Emma mints a 32-byte key, hashes the PIN with scrypt and a fresh salt, and
   stages both **unsaved**.
2. Emma binds the listener to `ws://<address>:47823`.
3. The QR is drawn immediately. It carries the address, the key, this Mac's
   name, and an expiry two minutes out. **It never carries the PIN.**
4. The phone scans it and connects, offering
   `sha256(key ‖ "emma-bridge-auth")` as the WebSocket subprotocol. A connection
   that cannot name that token is rejected before a single byte of protocol is
   read, in constant time.
5. The phone sends `unlock` with the PIN. Only that request is answered before
   the PIN is proved — everything else comes back
   `Enter this Mac's PIN on the phone to finish pairing.`
6. A correct PIN commits the pairing to disk. Until then nothing has been
   written, and walking away from the sheet leaves no trace.

**Why the PIN.** The key rides the QR in the clear for two minutes. Without a
PIN, a photograph of your screen — or someone standing behind you — is a working
pairing. With one, it is not: the code is necessary and no longer sufficient.
The PIN is asked once, at pairing. It is not a lock screen for the phone app, and
it does not help if the paired phone itself is stolen, because that phone already
holds the key.

**Five wrong PINs kill the staged pairing.** `MAX_PIN_TRIES` is spent per
pairing attempt, so the two-minute window is not a window to brute-force a
four-digit space in. Start over from **Pair a phone**.

The two minutes are enforced in the main process, not in the sheet that draws
the code. `pair()` arms a timer for `PAIRING_TTL_MS` that calls `cancelPair()`
itself, so a renderer that crashes or a window that is destroyed cannot leave the
staged key live and the port open. The renderer's countdown is a courtesy on top
of it. The timer is cleared when the PIN commits the pairing, when the sheet is
cancelled, and on quit, and it is unref'd so it never holds the process open.

## The handshake

Both ends send a 16-byte hello and derive one session digest,
`sha256(macHello ‖ phoneHello)`, which is the AES-GCM associated data for every
frame of that connection and the point from which the replay counters run. The
Mac re-randomises its hello on every connection it accepts, which is what kills a
frame captured on an earlier one.

Within one connection the desktop side still has to accept a second handshake: a phone
that goes out of range or is backgrounded rejoins with a fresh hello while the
Mac's socket is still open, and refusing it would leave the bridge dead until the
socket cycled. So the handshake is open to anything that got past the auth
subprotocol, and a handshake resets the replay counters.

`FrameCodec` therefore records the digest of every session under which a frame
has actually been opened, and refuses any handshake that lands back on one of
them. A genuine rejoin carries a hello the phone has just randomised, so its
session is new and it is heard. A replay of a captured hello necessarily
reproduces a session that already carried traffic, so it is refused and the
frames captured under it stay shut — including the case where the attacker first
sends junk to move the Mac off the session it is on. Only sessions that carried
traffic are remembered, so greeting the bridge with junk costs no memory, and the
set is cleared on every `restart()`.

Handshakes are otherwise unauthenticated work, so the desktop side answers each one with
its hello but pushes an unsolicited live state at most once a second. A phone
that greets in a quiet moment still gets its snapshot; a flood of greetings
cannot make the desktop side serialise and seal the agent list over and over.

One phone at a time. A new connection replaces the one before it, so a rejoining
phone never has to wait for the old socket to time out.

## What a paired phone can do

| | |
|---|---|
| Threads | Read, create, rename, archive, send a message, steer or stop a run |
| Live | The running agents, their steps, token counts and traces, streamed |
| Permissions | Every ask Emma would show on the computer, answerable from the phone |
| Git | Status, stage, commit, push, pull in your attached folders |
| Models | List and switch the model or permission mode for a thread |

An ask sent to the phone is still shown on the computer, and whichever end answers
first wins. Asks expire after ten minutes either way.

## Unpairing

Each paired phone gets its own row in **Settings → Mobile**, listed by the day it
was paired and whether it is connected. **Remove** it, twice — the button asks
for confirmation in place. Emma sends that phone a `bye` frame, drops its socket,
and rewrites `mobile-peers.json` without it. The other phones keep their sockets
and carry on; the port only closes once nothing is paired.

**Revoking a phone does not depend on reaching it.** It is the Mac that stops
answering: the record is gone and the key no longer opens the door, so a phone
that is off, off-network, lost, or stolen is locked out just as completely as one
sitting on the desk. **Getting a new phone is the same two steps** — remove the
old one, then pair the new one. Every pairing mints its own key, so the removed
phone fails the auth handshake before it can say anything.

What Emma cannot do is reach into the old phone and clear what it already
cached. The `bye` frame is its cue to forget the pairing, and only a phone that
is connected at that moment receives one.

## On disk

`mobile-peers.json` in `userData` holds one record per paired phone: the address,
this Mac's name, the scrypt
hash of the PIN, and the pairing key **encrypted with the macOS keychain**
through `safeStorage`. The PIN itself is never stored and never sent to the
phone. Emma refuses to pair at all when the keychain is unavailable rather than
writing the key in plain text, and a record loads as no pairing at all when its
key does not decrypt, its address is not a valid `ws://host:port`, its PIN hash
is malformed, or its pairing was never proved with a PIN.
