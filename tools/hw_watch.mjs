// hw_watch.mjs — long-running watchdog for the intermittent "motors go silent"
// fault. Scans on a loop and, the moment the reachable count drops below the
// high-water mark, captures everything needed to diagnose it before the
// condition clears itself.
//
//   node hw_watch.mjs /dev/cu.usbserial-110 [expected] [minutes]
//
// Writes hw_watch_log.txt continuously and hw_watch_capture.txt on the first drop.

import { Bus } from '../docs/js/serial.js';
import { ops } from '../docs/js/commands.js';
import { NodeSerialPort } from './node_serial.mjs';
import { appendFileSync, writeFileSync } from 'node:fs';

const PORT = process.argv[2] || '/dev/cu.usbserial-110';
const EXPECTED = Number(process.argv[3] || 35);
const MINUTES = Number(process.argv[4] || 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idHex = (id) => id.toString(16).toUpperCase().padStart(16, '0');

const bus = new Bus();
bus.logging = false;
await bus.open(new NodeSerialPort(PORT));

const log = (line) => { console.log(line); appendFileSync('hw_watch_log.txt', line + '\n'); };
log(`\n=== watch started, expecting ${EXPECTED}, running ${MINUTES} min ===`);

const deadline = Date.now() + MINUTES * 60_000;
let everSeen = new Set();
let captured = false;
let round = 0;

while (Date.now() < deadline) {
  round++;
  // One cumulative scan: several passes merged, the way the app does it.
  const found = new Set();
  let rx = 0, errs = 0, dropped = 0, best = 0;
  for (let p = 0; p < 4; p++) {
    bus.rxBytes = 0; bus.errorFrames = []; bus.framer.droppedBytes = 0;
    await ops.systemReset(bus, 255);
    await sleep(1500);
    bus.flushInput();
    let d = [];
    try { d = await ops.detectDevices(bus); } catch {}
    d.forEach((x) => found.add(idHex(x.uniqueId)));
    rx += bus.rxBytes; errs += bus.errorFrames.length; dropped += bus.framer.droppedBytes;
    best = Math.max(best, d.length);
    await sleep(200);
  }
  found.forEach((x) => everSeen.add(x));
  const stamp = new Date().toISOString().slice(11, 19);
  log(`${stamp} round ${String(round).padStart(3)}: ${found.size}/${EXPECTED} found ` +
      `(best single pass ${best}), rx ${rx}B, dropped ${dropped}B, errorPackets ${errs}`);

  if (found.size < everSeen.size && !captured) {
    captured = true;
    const missing = [...everSeen].filter((x) => !found.has(x));
    const lines = [`FAULT CAPTURED ${new Date().toISOString()}`,
      `reachable ${found.size}, previously seen ${everSeen.size}, missing ${missing.length}`,
      `rx ${rx}B  dropped ${dropped}B  errorPackets ${errs}  best single pass ${best}`, ''];
    lines.push('Probing each missing motor directly:');
    for (const id of missing) {
      const bid = BigInt('0x' + id);
      const probe = async (name, fn) => { try { return `${name}=${await fn()}`; } catch (e) { return `${name}=${e.constructor.name}`; } };
      const parts = [
        await probe('fwVersion', async () => { const r = await ops.getFirmwareVersion(bus, bid); return `v${r.version.join('.')}/boot=${r.inBootloader}`; }),
        await probe('status', async () => { const s = await ops.getStatus(bus, bid); return `flags=${s.raw},fatal=${s.fatalErrorCode}`; }),
        await probe('ping', async () => { const [e] = await bus.send(bid, 31, Uint8Array.from([1,2,3,4,5,6,7,8,9,10])); return e.length === 10 ? 'echo-ok' : 'short'; }),
      ];
      lines.push(`  ${id}  ${parts.join('  ')}`);
    }
    writeFileSync('hw_watch_capture.txt', lines.join('\n') + '\n');
    log(`  *** FAULT CAPTURED -> hw_watch_capture.txt (${missing.length} motors missing) ***`);
  }
  await sleep(2000);
}

log(`=== watch finished: high-water mark ${everSeen.size}, fault ${captured ? 'CAPTURED' : 'not seen'} ===`);
await bus.close();
process.exit(0);
