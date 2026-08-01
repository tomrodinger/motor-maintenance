# Motor Maintenance

Browser-based management tool for Gearotons servomotors. Detect, inspect, alias,
test and update motors on an RS485 bus straight from Chrome — no install, no
backend.

See [PLAN.md](PLAN.md) for the design, what was verified, and open questions.

## Run it

```sh
cd docs && python3 -m http.server 8777
```

Open <http://localhost:8777>. `localhost` counts as a secure context, so Web
Serial works without HTTPS during development.

- **With hardware:** click *Connect to serial port* and pick your RS485 adapter.
- **Without hardware:** click *or explore with three simulated motors*. The
  simulator speaks the real wire protocol — every byte in the bus console is
  genuine, and firmware is really downloaded from GitHub and really written page
  by page. Only the motors are fake.

## Deploy

Static files. Upload `app/` to any static host. Requires HTTPS (Web Serial is
secure-context only) — and note the hostname caveat at the top of PLAN.md.

## Verify the protocol layer

The wire protocol and firmware image transform are checked byte-for-byte against
the Python library in `tomrodinger/servomotor`:

```sh
cd tools
python3 gen_vectors.py  > vectors.json   # reference packets from the Python library
python3 fw_reference.py > fw_ref.json    # reference image transform
node verify_protocol.mjs                 # packet encoder, CRC32, response framer
node verify_firmware.mjs                 # .firmware parsing and page transform
```

Current result: CRC32 3/3, packets 7/7 byte-identical (including extended
addressing and a 2048-byte firmware page), framer correct when fed one byte at a
time, corrupted frames rejected, firmware transform exact.

## Layout

```
app/            the site — plain ES modules, no build step
  js/protocol.js    CRC32, packet encode, streaming response framer
  js/serial.js      Web Serial transport and request/response layer
  js/commands.js    command IDs and typed encoders/decoders
  js/firmware.js    GitHub sourcing, .firmware parsing, flash sequence
  js/fleet.js       scan / alias / alive-test / upgrade orchestration
  js/simulator.js   three fake motors on a fake bus
  js/app.js         rendering and wiring
  data/             motor_commands.json, data_types.json, error_codes.json
tools/          protocol verification scripts
research/       the servomotor repo (sparse checkout) and the tutorial site source
```

## Test against real hardware

`tools/` contains a Node shim that presents a POSIX tty as a Web Serial port, so
the app's own modules can be driven from the command line:

```sh
cd tools
node hw_probe.mjs                       # which adapter has motors on it?
node hw_test.mjs /dev/cu.usbserial-110  # full silent suite: scan, info, ping, identify, reset
node repeat_scan.mjs /dev/cu.usbserial-110 4   # scan repeatability
node hw_detect_convergence.mjs /dev/cu.usbserial-110 12  # per-pass detection yield
```

`hw_test.mjs` never enables MOSFETs and never moves a motor.
