// hw_reliability.mjs — per-motor response reliability.
//
// Are the "missing" motors intermittently silent, or is something about how we
// address them? Hammers every motor with the same unicast query and reports a
// success rate per motor, so flaky units separate from healthy ones.

import { Bus } from '../docs/js/serial.js';
import { Fleet, idHex } from '../docs/js/fleet.js';
import { ops, CMD } from '../docs/js/commands.js';
import { NodeSerialPort } from './node_serial.mjs';

const PORT = process.argv[2] || '/dev/cu.usbserial-110';
const TRIES = Number(process.argv[3] || 20);

// The eight that went silent during the first session.
const SUSPECT = new Set([
  '0129D5E093037E68', '08AB16E819F81873', '54B125BBEAE99E15', '6B1352D54D4F5B7F',
  '7B659204AA52A22A', '974FBD713E4B4455', 'B2AEDD3FE8C1ED2A', 'DCCA2FB16366F736',
]);

const bus = new Bus();
bus.logging = false;
const fleet = new Fleet(bus);
await bus.open(new NodeSerialPort(PORT));

console.log('Scanning...');
await fleet.scan({ enrich: false });
const present = fleet.list.filter((m) => m.present);
console.log(`${present.length} motors reachable\n`);
console.log(`Sending Get firmware version ${TRIES}x to each motor (unicast, extended addressing)\n`);

const rows = [];
for (const m of present) {
  let ok = 0, timeouts = 0, other = 0;
  const lat = [];
  for (let i = 0; i < TRIES; i++) {
    const t = Date.now();
    try { await ops.getFirmwareVersion(bus, m.uniqueId); ok++; lat.push(Date.now() - t); }
    catch (e) { if (e.constructor.name === 'TimeoutError') timeouts++; else other++; }
  }
  lat.sort((a, b) => a - b);
  rows.push({
    id: idHex(m.uniqueId), ok, timeouts, other,
    med: lat.length ? lat[lat.length >> 1] : null,
    max: lat.length ? lat.at(-1) : null,
    suspect: SUSPECT.has(idHex(m.uniqueId)),
  });
}

rows.sort((a, b) => a.ok - b.ok);
console.log('UNIQUE ID          OK/N   TIMEOUTS  MED  MAX   WAS-SILENT-EARLIER');
console.log('-'.repeat(70));
for (const r of rows) {
  console.log(`${r.id}  ${String(r.ok).padStart(2)}/${TRIES}   ${String(r.timeouts).padStart(6)}  ` +
              `${String(r.med ?? '-').padStart(3)}  ${String(r.max ?? '-').padStart(3)}   ${r.suspect ? 'yes' : ''}`);
}
console.log('-'.repeat(70));

const flaky = rows.filter((r) => r.ok < TRIES);
const perfect = rows.filter((r) => r.ok === TRIES);
console.log(`${perfect.length} motors answered every time, ${flaky.length} did not`);
if (flaky.length) {
  const overlap = flaky.filter((r) => r.suspect).length;
  console.log(`of the ${flaky.length} flaky, ${overlap} were among the 8 that went silent earlier`);
}
const suspectRows = rows.filter((r) => r.suspect);
if (suspectRows.length) {
  const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
  console.log(`\nearlier-silent motors: mean ${avg(suspectRows.map((r) => r.ok))}/${TRIES} ok`);
  console.log(`other motors:          mean ${avg(rows.filter((r) => !r.suspect).map((r) => r.ok))}/${TRIES} ok`);
}

await bus.close();
process.exit(0);
