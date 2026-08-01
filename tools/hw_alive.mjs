// hw_alive.mjs — alive test on real motors. THIS MOVES THE SHAFT.
// Usage: node hw_alive.mjs <port> [count]

import { Bus } from '../docs/js/serial.js';
import { Fleet, idHex } from '../docs/js/fleet.js';
import { NodeSerialPort } from './node_serial.mjs';

const PORT = process.argv[2] || '/dev/cu.usbserial-110';
const COUNT = Number(process.argv[3] || 1);

const bus = new Bus();
bus.logging = false;
const fleet = new Fleet(bus);
fleet.addEventListener('scan-progress', (e) => process.stdout.write(`\r  · ${e.detail.label}`.padEnd(70)));

await bus.open(new NodeSerialPort(PORT));
await fleet.loadReleaseIndex().catch(() => {});
await fleet.scan({ enrich: false });
const present = fleet.list.filter((m) => m.present);
console.log(`\n${present.length} motors on the bus; running the alive test on ${COUNT} of them\n`);

const targets = present.slice(0, COUNT);
let pass = 0;
for (const m of targets) {
  await fleet.refresh(m);
  if (!m.specs) { console.log(`${idHex(m.uniqueId)}  could not read specs: ${m.error}`); continue; }
  const specs = m.specs;
  process.stdout.write(`${idHex(m.uniqueId)}  ${specs.countsPerRotation} counts/rev @ ${specs.updateFrequency} Hz ... `);
  const t = Date.now();
  try {
    const r = await fleet.aliveTest(m, { rotations: 1, seconds: 2 });
    const ms = Date.now() - t;
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  turned ${r.achieved.toFixed(4)} rev ` +
                `(error ${r.errorPct.toFixed(2)} %), fatal=${r.fatalErrorCode}, ${ms} ms`);
    if (r.passed) pass++;
  } catch (e) {
    console.log(`ERROR ${e.constructor.name}: ${e.message}`);
  }
}

console.log(`\n${pass}/${targets.length} passed`);

// Leave the bus in a known-good state: everything de-energised.
console.log('Disabling MOSFETs on all motors and resetting the bus');
await bus.send(255, 0, undefined, { expectResponse: false });   // Disable MOSFETs, broadcast
await bus.send(255, 27, undefined, { expectResponse: false });  // System reset, broadcast
await new Promise((r) => setTimeout(r, 1500));

await bus.close();
process.exit(0);
