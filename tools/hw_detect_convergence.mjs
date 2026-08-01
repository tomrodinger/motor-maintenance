// hw_detect_convergence.mjs — how many detection passes does a busy bus need?
// With N motors each replying after an independent 0-950 ms delay, replies
// collide and some motors are missed. Measure the cumulative discovery curve.

import { Bus } from '../docs/js/serial.js';
import { ops } from '../docs/js/commands.js';
import { NodeSerialPort } from './node_serial.mjs';

const PORT = process.argv[2] || '/dev/cu.usbserial-110';
const PASSES = Number(process.argv[3] || 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bus = new Bus();
bus.logging = false;
await bus.open(new NodeSerialPort(PORT));

const seen = new Set();
const perPass = [];
console.log(`pass  found  new  cumulative  detect_ms`);
for (let i = 1; i <= PASSES; i++) {
  await ops.systemReset(bus, 255);
  await sleep(1500);
  bus.flushInput();
  const t = Date.now();
  let devices = [];
  try { devices = await ops.detectDevices(bus); } catch (e) { console.log(`  pass ${i} error: ${e.message}`); }
  const ms = Date.now() - t;
  let fresh = 0;
  for (const d of devices) {
    const k = d.uniqueId.toString(16);
    if (!seen.has(k)) { seen.add(k); fresh++; }
  }
  perPass.push({ found: devices.length, fresh, total: seen.size });
  console.log(`${String(i).padStart(4)}  ${String(devices.length).padStart(5)}  ${String(fresh).padStart(3)}  ${String(seen.size).padStart(10)}  ${String(ms).padStart(9)}`);
  if (ms < 1100) await sleep(1100 - ms);
}

await ops.systemReset(bus, 255);
await sleep(1500);

console.log(`\nTotal distinct motors: ${seen.size}`);
const perPassFound = perPass.map((p) => p.found);
console.log(`Per-pass yield: min ${Math.min(...perPassFound)}, max ${Math.max(...perPassFound)}, ` +
            `mean ${(perPassFound.reduce((a, b) => a + b, 0) / perPassFound.length).toFixed(1)}`);
// First pass index after which no new motor ever appeared again.
let converged = perPass.length;
for (let i = perPass.length - 1; i >= 0; i--) { if (perPass[i].fresh > 0) { converged = i + 1; break; } }
console.log(`Last pass that found something new: ${converged}`);
console.log(`Passes needed for a "2 consecutive dry passes" rule: ${Math.min(converged + 2, perPass.length)}`);

await bus.close();
process.exit(0);
