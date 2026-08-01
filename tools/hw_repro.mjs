// hw_repro.mjs — reproduce the "8 motors go silent" fault and localise it.
//
// Every detection pass records: motors found, raw bytes received, frames
// decoded, corrupt bytes discarded, and error packets. Those four numbers
// separate the candidate explanations:
//
//   bytes ~= 16 * expected, frames < expected  -> host framing loses replies
//   bytes  <  16 * expected, no error packets  -> motors genuinely not transmitting
//   error packets > 0                          -> motors latched in a fatal error
//                                                 (they answer, but with an error)

import { Bus } from '../docs/js/serial.js';
import { Fleet, idHex } from '../docs/js/fleet.js';
import { ops } from '../docs/js/commands.js';
import { NodeSerialPort } from './node_serial.mjs';

const PORT = process.argv[2] || '/dev/cu.usbserial-110';
const STAGE = process.argv[3] || 'all';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXPECTED = 35;

/** One detection pass with full instrumentation. Opens and closes its own bus
 *  unless one is supplied, so port-reopen effects can be measured. */
async function passOn(bus) {
  bus.rxBytes = 0;
  bus.errorFrames = [];
  bus.framer.droppedBytes = 0;
  await ops.systemReset(bus, 255);
  await sleep(1500);
  bus.flushInput();
  const devices = await ops.detectDevices(bus);
  return {
    found: devices.length,
    ids: devices.map((d) => idHex(d.uniqueId)),
    rxBytes: bus.rxBytes,
    dropped: bus.framer.droppedBytes,
    errors: bus.errorFrames.length,
    errorCodes: [...new Set(bus.errorFrames)],
  };
}

function report(tag, r) {
  const expectedBytes = EXPECTED * 16;
  console.log(`${tag.padEnd(30)} found ${String(r.found).padStart(2)}/${EXPECTED}  ` +
              `rx ${String(r.rxBytes).padStart(4)}B (all 35 would be ${expectedBytes}B)  ` +
              `dropped ${String(r.dropped).padStart(3)}B  errorPackets ${r.errors}` +
              (r.errorCodes.length ? ` codes=${r.errorCodes}` : ''));
  return r;
}

async function withFreshBus(fn) {
  const bus = new Bus();
  bus.logging = false;
  await bus.open(new NodeSerialPort(PORT));
  try { return await fn(bus); } finally { await bus.close(); }
}

const all = new Set();
const record = (r) => { r.ids.forEach((i) => all.add(i)); return r; };

console.log(`=== reproduction run, expecting ${EXPECTED} motors ===\n`);

// -------------------------------------------------------------- 0. baseline
console.log('[0] Baseline, fresh port');
await withFreshBus(async (bus) => {
  for (let i = 1; i <= 3; i++) record(report(`  baseline pass ${i}`, await passOn(bus)));
});
console.log(`  cumulative distinct: ${all.size}\n`);

// -------------------------------------------------------------- 1. reopen gaps
if (STAGE === 'all' || STAGE === 'reopen') {
  console.log('[1] Does reopening the port soon after closing it degrade the scan?');
  for (const gap of [0, 100, 500, 2000]) {
    await sleep(gap);
    await withFreshBus(async (bus) => {
      record(report(`  gap ${gap} ms, first pass`, await passOn(bus)));
    });
  }
  console.log(`  cumulative distinct: ${all.size}\n`);
}

// -------------------------------------------------------------- 2. alive tests
if (STAGE === 'all' || STAGE === 'alive') {
  console.log('[2] Alive tests (this is what immediately preceded the fault)');
  await withFreshBus(async (bus) => {
    const fleet = new Fleet(bus);
    await fleet.scan({ enrich: false });
    const present = fleet.list.filter((m) => m.present);
    console.log(`  scan before alive tests: ${present.length}`);
    for (const m of present.slice(0, 5)) {
      await fleet.refresh(m);
      if (!m.specs) { console.log(`  ${idHex(m.uniqueId)} specs unreadable: ${m.error}`); continue; }
      const r = await fleet.aliveTest(m, { rotations: 1, seconds: 2 }).catch((e) => ({ err: e.message }));
      console.log(`  ${idHex(m.uniqueId)} ${r.err ? 'ERROR ' + r.err : (r.passed ? 'PASS' : 'FAIL') + ' ' + r.achieved.toFixed(4) + ' rev'}`);
    }
    for (let i = 1; i <= 3; i++) record(report(`  after alive test, pass ${i}`, await passOn(bus)));
  });
  console.log(`  cumulative distinct: ${all.size}\n`);
}

// -------------------------------------------------------------- 3. verdict
console.log('=== summary ===');
console.log(`distinct motors seen across every pass: ${all.size}/${EXPECTED}`);
if (all.size < EXPECTED) {
  console.log('\nMotors never seen in this run:');
  const seen = [...all].sort();
  const { readFileSync } = await import('node:fs');
  try {
    const known = readFileSync('detected_before_power_cycle.txt', 'utf8').trim().split('\n');
    for (const k of known) if (!all.has(k)) console.log(`  ${k}`);
  } catch { console.log('  (no reference list)'); }

  console.log('\nProbing each missing motor directly by unique ID:');
  const { readFileSync: rf } = await import('node:fs');
  const known = rf('detected_before_power_cycle.txt', 'utf8').trim().split('\n');
  await withFreshBus(async (bus) => {
    for (const k of known.filter((x) => !all.has(x))) {
      const id = BigInt('0x' + k);
      let fwv = 'silent', st = 'silent';
      try { const r = await ops.getFirmwareVersion(bus, id); fwv = `v${r.version.join('.')} boot=${r.inBootloader}`; }
      catch (e) { fwv = e.constructor.name; }
      try { const s = await ops.getStatus(bus, id); st = `flags=${s.raw} fatal=${s.fatalErrorCode}`; }
      catch (e) { st = e.constructor.name; }
      console.log(`  ${k}  getFirmwareVersion=${fwv}  getStatus=${st}`);
    }
  });
} else {
  console.log('All motors accounted for — fault not reproduced by these steps.');
}
process.exit(0);
