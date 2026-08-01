# Motor Maintenance — plan for `motor-maintenance.gearotons.com`

> ### ⚠️ Read this first: the planned hostname will not work
>
> `motor_maintenance.gearotons.com` has an **underscore**. Underscores are
> prohibited in certificate `dNSName` SAN entries (CA/B Forum Ballot SC12), so no
> public CA will issue a certificate for it. Web Serial is secure-context gated —
> without HTTPS, `navigator.serial` is `undefined` and nothing works at all.
>
> I checked: neither `motor_maintenance.gearotons.com` nor
> `motor-maintenance.gearotons.com` resolves yet, so nothing is deployed and
> **renaming to the hyphenated form costs nothing right now.** This plan assumes
> `motor-maintenance.gearotons.com`.
>
> Related: `Permissions-Policy: serial` defaults to `'self'`, so if the page is
> ever iframed the embed needs `allow="serial"`.


A static, self-contained web app that replaces `upgrade_firmware.py`,
`show_device_information_for_all_devices.py` and `detect_and_set_alias_all_devices.py`,
plus adds alive-test / identify / reset.

**Status: a working first draft is in `app/`.** It is real, not a mockup — it
detects motors, reads them, assigns aliases, runs the alive test, and flashes
firmware downloaded live from GitHub. Try it with the built-in simulator
(link on the welcome screen) or with real hardware.

**Tested on the 35-motor rack** (`/dev/cu.usbserial-110`), silent commands only.
See §8 — the rack found a real bug that would have crippled this tool on any
busy bus.

---

## 1. What I studied

| Source | What I took from it |
|---|---|
| `tomrodinger/servomotor` → `python_programs/servomotor/communication.py` | The wire protocol, ported byte-for-byte |
| `…/motor_commands.json`, `data_types.json`, `error_codes.json` | 48 commands, their payload layouts, 54 fatal-error explanations |
| `…/upgrade_firmware.py` | `.firmware` format, image transform, page timing |
| `…/detect_and_set_alias_all_devices.py`, `show_device_information_for_all_devices.py`, `device_detection.py` | Scan procedure, alias policy, the info table |
| `…/command_examples/example_trapezoid_move.py` | The exact alive-test sequence |
| `firmware/firmware_releases/*.firmware` | Header verified by hex dump on M17 / M3 / M23 files |
| `tutorial.gearotons.com` (downloaded and de-minified) | Its Web Serial layer — **mostly as a list of things not to repeat** |

### What the tutorial site does well, and what to leave behind

The tutorial is a SvelteKit + Tailwind 4 / DaisyUI app. Its whole serial layer
lives in one chunk. Worth keeping: the raw-bytes log window (excellent for
trust and debugging), the hardcoded 230400 baud with no baud selector, and the
`requestPort()` call with **no USB filters** — filters would hide legitimate
adapters.

Worth **not** copying — these are real defects I verified in the bundle:

- **Framing is fragile.** It does `expectedLength = buf[0] >> 1; if (buf.length != expectedLength) continue;`.
  One extra byte — RS485 echo, noise, two frames in one USB transfer — and that
  equality never holds again. The buffer grows forever and the connection wedges
  silently. I hit a milder version of the same class of bug and the 35-motor rack
  caught it — see §8 for the fix, which is the single most important piece of
  code in this tool.
- **Multi-device detection is broken.** `Detect devices` gets one reply per motor
  after independent random delays, but the read pump clears its command queue
  after the *first* reply, and the layout hook *replaces* the device array. It can
  only ever see one motor. This is the single most important thing to get right,
  since everything else depends on knowing what is on the bus.
- **Its bundled `motor_commands.json` is a stale schema** and its
  `counts_per_timestep` conversion factor is wrong by ~104×. We ship the repo's
  current JSON instead.
- Disconnect is timing-based (`setTimeout(resolve, 1000)`) and deadlocks if
  already half-torn-down.

---

## 2. Architecture

Vanilla ES modules, no build step, no framework, no dependencies. The whole app
is static files; the only network calls are to GitHub for firmware.

```
app/
  index.html          markup
  styles.css          one stylesheet, dark instrument-panel theme
  data/               motor_commands.json, data_types.json, error_codes.json  (from the repo)
  js/
    protocol.js       CRC32, packet encode, streaming response framer     ← verified vs Python
    serial.js         Web Serial transport, read pump, request/response
    commands.js       command IDs, typed encoders/decoders, status bits
    firmware.js       GitHub sourcing, .firmware parsing, flash sequence  ← verified vs Python
    fleet.js          scan / enrich / alias / alive-test / upgrade orchestration
    simulator.js      three fake motors speaking the real protocol
    app.js            rendering and wiring
```

Why no framework: this must still build and run in five years with no toolchain,
and the whole thing is ~1500 lines. If it grows, Svelte would be the natural
step (and would match the tutorial site).

---

## 3. The protocol layer (verified)

```
TX:  [size] [address] [command] [payload…] [CRC32 LE]
     size  = (totalBytes << 1) | 1          — totalBytes counts every byte incl. size and CRC
     if totalBytes > 127: size = 0xFF, then uint16 LE total (+2 to the total)
     address = alias byte, or 254 followed by 8-byte LE unique ID

RX:  [size] [253 or 252] [errorCode] [payload…] [CRC32 LE]
     253 = CRC32 present, 252 = absent. Empty payload = plain ACK.
     errorCode != 0 → fatal error; look it up in error_codes.json.
```

230400 8N1, no flow control. CRC32 is standard zlib (poly `0xEDB88320`) over the
whole packet including the size bytes.

**A latent bug inherited from the Python library.** `encode_first_byte(127)` is
`0xFF`, which is *also* the extended-size marker. A short-form packet totalling
exactly 127 bytes therefore emits `0xFF` with no 2-byte size field and cannot be
framed by the receiver. `communication.py:321` tests `> 127` and has the same
hole. No command this tool sends can land on 127, so rather than silently emit a
corrupt packet or deviate from the encoder that is proven on hardware, the JS
throws a clear error if it ever happens. Worth fixing in the Python library too.

**Verification.** I generated reference packets from the actual Python library
and compared bytes:

```
crc32:   3/3 match zlib
packets: 7/7 byte-identical to Python   (incl. extended addressing and a 2048-byte
                                         firmware page using extended size encoding)
framer:  parses correctly when fed one byte at a time
crc:     corrupted frame rejected
resync:  5/5 intact frames recovered around a corrupt one, byte-at-a-time
resync:  5/5 recovered from a single coalesced chunk
```

The two `resync` cases are a regression test for the bug the rack found (§8).
Against the old framer they returned 1 of 5.

### Design decision: address by unique ID, never by alias

Every per-motor command uses extended addressing (254 + 8-byte unique ID). This
is the difference between the Python tools and this one:
`show_device_information_for_all_devices.py` *skips* motors whose alias is 255
and warns about duplicates. With unique-ID addressing neither case matters — a
motor fresh from the box, or three motors that all think they are alias 3, are
all fully manageable. Aliases become a convenience the user opts into, not a
prerequisite for doing anything.

---

## 4. Firmware

### File format (verified by hex dump on real files)

```
[0..7]  model code, 8 ASCII bytes, space padded    "M17     " / "M3      " / "M23     "
[8]     firmware compatibility code (the "scc" in the filename)
[9..]   raw application image
```

Before sending, `upgrade_firmware.py` transforms the image; we reproduce it exactly:
pad to a multiple of 4, replace the first word with `(len>>2)-1`, append
`crc32(image[4:])`, then write 2048-byte pages starting at flash page 5.
Verified against `servomotor_M17_fw0.15.9.0_scc3_hw1.5.firmware`: model, scc,
CRC, payload length, page count and per-page CRCs all match the Python output.

### Compatibility rule — the part that carries bricking risk

Filenames encode `servomotor_<model>_fw<a.b.c.d>_scc<n>_hw<major.minor>`.
Device `Get product info` returns product code, firmware compatibility code and
hardware version.

- The **bootloader itself checks model code + compatibility code** on every page,
  and ignores pages that do not match. That is what makes a broadcast upgrade safe.
- The **hardware revision is not checked by the device.** The host must get it right.
  We match on `major.minor` of the hardware version, and when there is no exact
  build we still surface the nearest one but flag it `check hw` and warn in the
  confirmation dialog rather than flashing silently.
- Before any page is sent we re-check the parsed file header against the target
  motor's own reported values and abort on mismatch.

### Sourcing (all verified live)

| Purpose | Endpoint | CORS | Notes |
|---|---|---|---|
| List releases | `api.github.com/repos/…/contents/firmware/firmware_releases` | `*` | 60 req/hr/IP unauthenticated |
| Download bytes | `cdn.jsdelivr.net/gh/tomrodinger/servomotor@main/…` | `*` | CDN, no rate limit |
| Fallback | `raw.githubusercontent.com/…` | `*` | |

The listing is cached in `localStorage` with its ETag and re-fetched with
`If-None-Match`; a 304 does not count against the rate limit, so the page can be
reloaded freely. If GitHub is unreachable the cached listing is used and the
status pill turns amber. The index loads on page open, before any serial
connection — so the user sees what is available even without hardware attached.

`data.jsdelivr.com`'s directory API rejects this repo (403/400), so it is not a
listing fallback.

### Upgrade sequence

```
broadcast System reset (27)              → devices enter their bootloader window
wait 70 ms                                 must be 2–130 ms; outside that the window closes
for each page (5, 6, 7 …):
    Firmware upgrade (23), broadcast
    payload = modelCode[8] + scc[1] + pageNumber[1] + 2048 bytes
    wait 180 ms                            ≥130 ms or the device's buffer overflows
broadcast System reset (27)
wait 1.5 s, then re-read each motor and confirm the new version
```

Motors needing the same image are grouped and flashed in a **single broadcast
pass** — twenty M17s take the same time as one. That is what makes "update all"
genuinely one click.

---

## 5. Operation sequences

**Scan** (from `device_detection.py`): 3× [broadcast reset → wait 1.5 s → flush →
`Detect devices` → pad to 1.1 s], merge by unique ID, final reset. Then read each
motor: product info, firmware version, product specs, status, voltage,
temperature, description. About 13 s with a progress bar naming each step.

**Alive test** (from `example_trapezoid_move.py`): reset → enable MOSFETs →
wait 300 ms for the commutation snap → zero position → `Trapezoid move` of
`countsPerRotation` counts over `2 × updateFrequency` timesteps → poll
`Get n queued items` to 0 → read position → check it landed within 2 % of one
revolution and no fatal error → disable MOSFETs. `countsPerRotation` and
`updateFrequency` come from `Get product specs`, never hardcoded.

**Aliases**: keeps every already-unique alias and only reassigns conflicts and
unassigned motors, filling from 1 upward. Shows the full plan before touching
anything. After each `Set device alias` the bus stays silent 800 ms — the device
answers first, then writes flash and reboots, and polling during that window
pins it in its bootloader.

---

## 6. UX

- **Zero to useful in one click.** Connect → automatic scan → cards.
- **One primary action.** "Update all N motors" appears only when there is
  something to update; ticking cards narrows it to "Update N selected".
- **Every destructive action shows its plan first** — which motor, from which
  version to which, what will change.
- **Honest progress.** Named steps ("Writing M3 0.13.0.0 — page 7 of 18"), not a
  spinner.
- **Bus console** with real TX/RX hex, collapsed by default. Inherited from the
  tutorial site; it is what makes the tool trustworthy when something is wrong.
- **Simulator** built in, so the UI can be demonstrated and tested with no hardware.
- Fatal error codes are shown with the plain-English text and suggested fix from
  `error_codes.json`, not as a bare number.

---

## 7. Open questions for you

1. **Hardware-revision matching.** I match on `major.minor`. Older files use
   `hwV11`, `hwV10`, `hwV11RC4`, `hw0.10`. Is `major.minor` the right rule, and
   should a motor with no exact-hardware build be offered the nearest one at all,
   or refused?
2. **Scan resets every motor** (3 passes, ~13 s), because that is what the Python
   tools do. Should there be a faster no-reset rescan for a known-good bus?
3. **Alive test defaults**: 1 revolution over 2 s, pass if within 2 % and no fatal
   error. Right numbers? Should it also verify against `Get hall sensor position`?
4. **Alias range**: I use 1–251 (the Python tool uses 1–253, but 252/253 raise
   `ERROR_BAD_ALIAS` per the current firmware docs — I believe the Python
   constant is stale).
5. Should the app also expose **calibration**, given `detect_and_set_alias_all_devices.py`
   has a `-c` option? It takes 30 s per motor and needs a strong supply.
6. Ship `motor_commands.json` bundled (offline-capable, current behaviour) or
   always fetch it from the repo so command metadata tracks firmware?

---

## 8. Hardware test results — 35-motor rack

Run against `/dev/cu.usbserial-110` with `tools/hw_test.mjs`, which drives the
app's own modules (`protocol.js`, `serial.js`, `fleet.js`) through a Node shim
for Web Serial. No MOSFETs were enabled and nothing moved.

Of the three adapters, only `usbserial-110` has motors; `usbserial-1420`,
`usbserial-1430` and `usbmodem2101` are silent.

| Check | Result |
|---|---|
| Motors found | **35 / 35**, repeatable across four consecutive scans |
| Full info read | **35 / 35** clean, 1.6 s for all of them |
| Scan time | 9.5–12.1 s (3–4 adaptive passes) |
| Ping echo | 10-byte payload returned intact, 5–15 ms |
| Identify | LED flash confirmed, unicast and broadcast |
| Targeted reset | recovers and re-reads correctly |
| Reliability | **200 / 200** queries, 0 failures, median 6 ms, max 22 ms |
| Fatal errors | none on any motor |

The rack is uniform: all M17, hardware 1.5.0, scc 3, firmware 0.15.9.0, serials
1009–1331, 24.0–24.5 V, 38–45 °C. **Every motor shares alias 88** (ASCII `X`) —
the exact duplicate-alias case that stops the Python tools from reading them.
Because this tool addresses by unique ID, all 35 read correctly without touching
a single alias. Firmware matching returned `exact` confidence for all 35, so the
hardware-version rule (`1.5.0` → `hw1.5`) is right on real devices.

### The bug the rack found

The first scan looked fine — 26 motors, then 33 with three passes. But repeated
passes gave wildly inconsistent counts: **35, 18, 1, 35, 17, 34, 20, 13, 27, 5,
35, 16.** A pass returning 1 motor is not explicable by collisions.

Instrumenting the byte stream showed the cause immediately:

```
pass 1: 35 devices, 560 rx bytes, 35 frames decoded,  0 framing errors
pass 3: 13 devices, 559 rx bytes, 13 frames decoded, 15 framing errors
```

**All 35 replies arrive every time** — 560 bytes is exactly 35 × 16. The motors
were never the problem. My framer was destroying them: it consumed `packetSize`
bytes *before* validating the CRC, so a single corrupted length byte swallowed a
dozen good frames behind it and never resynchronised.

Fixed by validating a candidate frame completely — plausible size, correct
response character, correct CRC32 — *before* consuming any byte, and on failure
dropping exactly one byte and rescanning from the next offset. Plus a
timeout-driven resync for the case where a corrupt length looks plausible but
its bytes never arrive.

Result on the same rack, same test:

| | before | after |
|---|---|---|
| motors per pass, mean | 21.3 | **33.1** |
| motors per pass, min | 1 | **31** |
| passes to find all 35 | luck | **2** |

The residual 2–4 lost per pass is genuine electrical collision — two motors
transmitting simultaneously, which no framer can recover — and is handled by the
multi-pass merge.

This is worth flagging beyond this tool: **the tutorial site has the same class
of bug in a worse form**, and the Python library discards an entire detection
pass on any CRC failure rather than recovering the intact frames in it.

### Consequent design change: adaptive pass count

A fixed 3 passes was a guess. Since per-pass yield depends on how crowded the bus
is, the scan now runs until **two consecutive passes turn up nothing new**
(minimum 2, maximum 8), and warns if it hits the cap while still finding motors.
That converges in 2 passes on a 3-motor bus and 3–4 on the rack. Detection also
now listens for a fixed 1150 ms window rather than waiting for a 1400 ms idle
gap, since replies are spec-bounded to 950 ms — same coverage, ~1.2 s faster per
pass.

### The "8 motors silent" investigation — not reproduced

Partway through the first session the rack dropped from 35 reachable motors to 27
and stayed there for ~10 minutes across a dozen separate processes. The same 8
were silent to broadcast detection *and* to direct unique-ID queries, while their
green heartbeat LEDs kept blinking. They then recovered on their own.

After a power cycle I tried to trigger it deliberately. **It did not reproduce.**
What each experiment settled:

| Experiment | Result |
|---|---|
| Per-motor unicast reliability, 20 queries × 35 motors | **700/700**, including all 8 suspects, median 5 ms |
| Alive tests, then rescan | not reproduced (cumulative 35) |
| Reopening the port at 0 / 100 / 500 / 2000 ms gaps | per-pass yield varied 24–33, cumulative always 35 |
| Full firmware downgrade + upgrade, then 5 scans | not reproduced (cumulative 35) |

Two things the instrumentation did settle, both worth knowing:

- **It is not my framing.** Bytes received tracks motors found almost exactly
  (25 found → 416 B, where 25 × 16 = 400). When a motor is missing, its reply
  never arrives on the wire at all. Corrupt bytes discarded are single or double
  digits per pass.
- **It is not a latched fatal error.** Zero error packets in every pass. A motor
  in the fatal-error state answers Detect devices with an error packet instead of
  its unique ID, which would make it invisible to detection while alive — a
  plausible-looking theory that the data killed. The bus now counts those frames
  so the case would be visible if it ever occurred.

So the fault is real, intermittent, and outside anything the host controls. It
never manifested as a wrong reading — only as fewer motors.

### Consequent fix: a short scan must never look confident

The investigation exposed a genuine defect in my own scan logic. Per-pass yield
on this rack naturally varies between 30 and 35 because replies collide, so
"two consecutive passes found nothing new" can be satisfied while motors are
still missing — and the scan would then report the short count as settled fact.

Convergence now requires two conditions: no pass turning up anything new, **and**
at least one single pass having seen the entire cumulative set. If the cap is hit
without that, the scan says the bus is marginal and names the numbers, rather than
quietly under-reporting. Motors seen in a previous scan but missing now are
already kept and shown as absent rather than forgotten.

### Alive test — verified

One motor, 1 revolution over 2 s: **turned 1.0000 revolutions, 0.00 % error**, no
fatal error, 4.1 s including the reset and settle. The sequence in §5 is correct
as written.

### Bootloader window — verified, and better than feared

Measured over 10 trials on a real motor, without writing any flash: reset, wait,
send a harmless addressed query, ask whether it ended up in the bootloader.

- **10/10 caught the bootloader** at a 70 ms delay.
- `setTimeout(70)` actually slept **69.3–70.4 ms** — far more accurate than I
  assumed, against a ~250 ms ceiling.
- Sweeping the delay: held in the bootloader at 10, 40, 70, 120, 200 and 240 ms;
  launched the application at 300 ms. So the real window is ~250 ms and 70 ms sits
  comfortably inside it.
- Bootloader version on this hardware is 1.1.1.0.

### Firmware upgrade — verified, after two real bugs

**Full round trip on all 35 motors:** downgraded 0.15.9.0 → 0.15.3.4 (6.7 s), the
app then reported 35/35 needing an update and picked 0.15.9.0 with `exact`
confidence, and `Fleet.upgrade()` — the code path behind the Update button —
brought all 35 back (8.9 s), verified 35/35, no fatal errors, none stuck in the
bootloader. The rack ended exactly where it started.

Getting there exposed two bugs, and one bad piece of test design on my part.

**Bug 1 — long writes drop bytes.** A 2069-byte firmware page written in a single
call is *never received*. The identical bytes split into 1000-byte chunks 50 ms
apart are received every time:

| how the page is written | received? |
|---|---|
| one `write()` of 2069 bytes | **no** — the device booted the application |
| 1000-byte chunks, 50 ms apart | **yes** — held in the bootloader |

`upgrade_firmware.py` documents this exact workaround in `program_one_page`
("otherwise there is a strange bug where bytes get dropped") — but only on its
*old*-protocol path. The new-protocol path it uses by default writes the packet in
one call, and that is the code I ported. `Bus.writePacket()` now chunks anything
over 1000 bytes.

**Bug 2 — and a wrong conclusion I later overturned.** I first reported that a
Firmware upgrade page addressed to one device by unique ID was ignored outright,
and therefore that upgrades were broadcast-only and subsets impossible. **That was
wrong.** The test predated the chunked-write fix, so the 2069-byte page was going
out as one burst and being dropped — the same defect as Bug 1, which I had
diagnosed for broadcast without re-running the unicast case.

Re-tested with chunked writes (`tools/hw_unicast_flash.mjs`):

```
[1] unicast by unique ID   still in bootloader: true   (packet received)
[2] page 18/18  acked 18  timed out 0
[3] target 0C729700C8B96AC7: 0.15.9.0 -> 0.15.3.4
    other motors changed: 0
    UNICAST FIRMWARE UPGRADE WORKS
```

So single-motor flashing works and is *acknowledged per page*, which means it
needs no inter-page delay at all — the ACK is the flow control. Broadcast still
has none, so it keeps the 180 ms pacing.

The app now picks the addressing itself: broadcast when the selection already
covers every motor of that model and compatibility code, unicast per motor
otherwise. Bus-wide flashing is also offered explicitly from the broadcast card.

**My testing mistake.** My first flash test re-wrote the version the motors were
already running and I called it a pass. It proved nothing: the end state is
identical whether the write succeeds or does nothing at all — which is exactly what
was happening. Only the downgrade, where the expected version differs from the
current one, could tell the difference. Any firmware test must change the version.

---

## 9. What the draft does not do yet

- The broadcast card's alive-test-all and set-alias-on-all have only been run
  against the simulator. Everything else on that card, and both firmware paths,
  are verified on hardware.
- No retry/resume if an upgrade is interrupted mid-flash. Recovery is currently
  "run it again" — which works, because the bootloader keeps a device with a bad
  application CRC in the bootloader, and pages 0–4 are never written.
- No retry/resume if an upgrade is interrupted mid-flash.
- No per-motor targeted upgrade (uses broadcast grouping; targeted flash by
  unique ID is implemented in `flashFirmware` but not exposed).
- Serial reconnection after unplug requires a manual reconnect.
- No calibration, homing, or motion tuning.
