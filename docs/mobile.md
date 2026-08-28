# Mobile

A paired iPhone drives the same threads this Mac does: it sends messages, reads
the live run, answers the tool permission prompts Emma would otherwise put in
front of you, and runs git. The phone app is a separate repository —
[tronschell/emma-mobile](https://github.com/tronschell/emma-mobile) — and it
talks to Emma through a relay **you deploy**, not one Emma ships.

Three things have to be true before a phone can pair, in this order:

1. A relay of your own is deployed, and its address is in **Settings → Mobile**.
2. Emma Mobile is installed on the phone.
3. Both devices are online. They never talk to each other directly.

## The relay

Both ends dial out to a Cloudflare Worker, so neither device needs an open port,
a VPN, a tunnel daemon, a domain, or a static address. The Worker is in
[`relay/`](https://github.com/tronschell/emma-mobile/tree/main/relay) in the
Emma Mobile repository, and deploying it is two commands:

```sh
cd relay
npx wrangler login
npx wrangler deploy
```

The last line of `wrangler deploy` prints
`https://emma-relay.<your-subdomain>.workers.dev`. Emma wants the `wss://` form
of the same host — **scheme and host only**, no trailing slash, path, or query.
Paste it into **Settings → Mobile → Relay**. `EMMA_RELAY_URL` overrides the
field when it is set, which is how you point a dev build at a staging relay.

There is no shared relay. Emma has no default address baked in, and the field is
empty on a fresh install: your phone traffic goes through your Cloudflare
account and nobody else's.

**What the relay can see.** Ciphertext only. Every frame is sealed end to end by
[`frames.ts`](../desktop/main/frames.ts) before it leaves the Mac, and the
Worker holds no key that opens one. What it does see, and what you should treat
as visible to Cloudflare: the room id in the request path, the SHA-256 auth
token derived from the pairing key, and the size and timing of each frame.
`observability` is off in `wrangler.jsonc` so none of that is sampled into
Workers Logs.

**What it costs.** Nothing, in practice. The Durable Object uses the WebSocket
Hibernation API and answers keepalives without waking, so an idle pairing bills
almost no duration. The free tier's 100,000 requests a day is far above what one
phone generates — incoming WebSocket messages bill at 20:1.

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

**Settings → Mobile → Pair a phone** on the Mac, then **Pair** in Emma Mobile
and hold the camera over the code.

What happens behind the sheet, in [`bridge.ts`](../desktop/main/bridge.ts):

1. Emma mints a 16-byte room id and a 32-byte key, and stages them unsaved.
2. Emma opens the relay socket and **claims the room** — the first connection to
   reach a room owns it, so the QR is drawn only after the claim succeeds. A
   room-id guesser is never first. If the claim does not land in ten seconds the
   sheet fails with `This Mac could not reach the pairing relay.`
3. The QR is drawn. It carries the relay address, the room, the key, this Mac's
   name, and an expiry two minutes out.
4. The phone scans it, connects as `?role=phone`, and sends its handshake.
5. The first sealed frame from the phone is what commits the pairing to disk.
   Until then nothing has been written, and walking away from the sheet leaves
   no trace.

The QR contains the raw key in the clear. It is on your screen for two minutes —
treat it like a password, and pair only a phone you are holding.

The two minutes are enforced in the main process, not in the sheet that draws
the code. `pair()` arms a timer for `PAIRING_TTL_MS` that calls `cancelPair()`
itself, so a renderer that crashes or a window that is destroyed cannot leave
the staged key live and the room claimed. The renderer's countdown is a
courtesy on top of it. The timer is cleared when the first sealed frame commits
the pairing, when the sheet is cancelled, and on quit, and it is unref'd so it
never holds the process open.

## The handshake

Both ends send a 16-byte hello and derive one session digest,
`sha256(macHello ‖ phoneHello)`, which is the AES-GCM associated data for every
frame of that connection and the point from which the replay counters run. The
Mac re-randomises its hello on every socket it opens, which is what kills a
frame captured on an earlier connection.

Within one connection the Mac still has to accept a second handshake: a phone
that goes out of range or is backgrounded rejoins with a fresh hello while the
Mac's socket is still open, and refusing it would leave the bridge dead until
the Mac's own socket cycled. So the handshake is open to anything that can write
into the relay room, and a handshake resets the replay counters.

`FrameCodec` therefore records the digest of every session under which a frame
has actually been opened, and refuses any handshake that lands back on one of
them. A genuine rejoin carries a hello the phone has just randomised, so its
session is new and it is heard. A replay of a captured hello necessarily
reproduces a session that already carried traffic, so it is refused and the
frames captured under it stay shut — including the case where the attacker
first sends junk to move the Mac off the session it is on. Only sessions that
carried traffic are remembered, so greeting the bridge with junk costs no
memory, and the set is cleared on every `restart()`.

Handshakes are otherwise unauthenticated work, so the Mac answers each one with
its hello but pushes an unsolicited live state at most once a second. A phone
that greets in a quiet moment still gets its snapshot; a flood of greetings
cannot make the Mac serialise and seal the agent list over and over.

## What a paired phone can do

| | |
|---|---|
| Threads | Read, create, rename, archive, send a message, steer or stop a run |
| Live | The running agents, their steps, token counts and traces, streamed |
| Permissions | Every ask Emma would show on the Mac, answerable from the phone |
| Git | Status, stage, commit, push, pull in your attached folders |
| Models | List and switch the model or permission mode for a thread |

An ask sent to the phone is still shown on the Mac, and whichever end answers
first wins. Asks expire after ten minutes either way.

## Unpairing

**Settings → Mobile → Unpair**, twice — the button asks for confirmation in
place. Emma sends the phone a `bye` frame, deletes `mobile-peer.json`, and drops
the socket. The old room is abandoned; the next pairing mints a fresh room and
key, so a phone that was unpaired while offline can never reconnect.

## On disk

`mobile-peer.json` in `userData` holds the room, the relay address, this Mac's
name, and the pairing key **encrypted with the macOS keychain** through
`safeStorage`. Emma refuses to pair at all when the keychain is unavailable
rather than writing the key in plain text, and a record whose key does not
decrypt, or whose relay is not a valid `wss://` origin, loads as no pairing at
all.
