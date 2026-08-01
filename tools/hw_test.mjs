// hw_test.mjs — exercise the app's real Fleet logic against the test rack.
// SILENT ONLY: no MOSFETs, no motion. Detection, info reads, identify, reset.

import { Bus } from '../docs/js/serial.js';
import { Fleet, idHex } from '../docs/js/fleet.js';
import { ops } from '../docs/js/commands.js';
import { NodeSerialPort } from './node_serial.mjs';

const PORT = process.argv[2] || '/dev/cu.usbserial-110';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bus = new Bus();
bus.logging = false;
const fleet = new Fleet(bus);
fleet.addEventListener('scan-progress', (e) => console.log(`  · ${e.detail.label}`));
fleet.addEventListener('warning', (e) => console.log(`  ! ${e.detail.message}`));

console.log(`=== Hardware test on ${PORT} ===\n`);
await bus.open(new NodeSerialPort(PORT));

// ---------------------------------------------------------------- 1. index
console.log('[1] Firmware index from GitHub');
const idx = await fleet.loadReleaseIndex();
console.log(`    ${idx.releases.length} releases, source: ${idx.source}\n`);

// ---------------------------------------------------------------- 2. scan
console.log('[2] Bus scan — adaptive passes (resets + Detect devices, no motion)');
const t0 = Date.now();
await fleet.scan({ enrich: false });
const present = fleet.list.filter((m) => m.present);
console.log(`    ${present.length} motors in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);

// ---------------------------------------------------------------- 3. info
console.log('[3] Reading full device information (extended addressing by unique ID)');
const ti = Date.now();
let okCount = 0;
for (const m of present) {
  await fleet.refresh(m);
  if (!m.error) okCount++;
}
console.log(`    ${okCount}/${present.length} read cleanly in ${((Date.now() - ti) / 1000).toFixed(1)} s\n`);

const rows = present.map((m) => ({
  uid: idHex(m.uniqueId),
  alias: m.alias === 255 ? 'none' : String(m.alias),
  model: m.info?.productCode ?? '?',
  hw: m.info?.hardwareVersion ?? '?',
  scc: m.info?.firmwareCompatibility ?? '?',
  serial: m.info?.serialNumber ?? '?',
  fw: m.firmwareVersion?.join('.') ?? '?',
  v: m.voltage != null ? m.voltage.toFixed(1) : '?',
  t: m.temperature ?? '-',
  err: m.status?.fatalErrorCode ?? '?',
  desc: m.description ?? '',
  upd: m.updateAvailable ? `-> ${m.firmware.release.versionStr}` : (m.firmware?.release ? 'latest' : 'no release'),
  conf: m.firmware?.confidence,
  problem: m.error,
}));

console.log('UNIQUE ID        ALIAS MODEL HW     SCC SERIAL   FIRMWARE   V     T  ERR UPDATE');
console.log('-'.repeat(96));
for (const r of rows) {
  console.log(
    `${r.uid} ${r.alias.padEnd(5)} ${String(r.model).padEnd(5)} ${String(r.hw).padEnd(6)} ` +
    `${String(r.scc).padEnd(3)} ${String(r.serial).padEnd(8)} ${r.fw.padEnd(10)} ${r.v.padEnd(5)} ` +
    `${String(r.t).padEnd(2)} ${String(r.err).padEnd(3)} ${r.upd}${r.problem ? '  ERROR: ' + r.problem : ''}`);
}
console.log('-'.repeat(96));

const by = (k) => [...new Set(rows.map((r) => r[k]))].sort();
console.log(`models=${by('model')} hw=${by('hw')} scc=${by('scc')} fw=${by('fw')}`);
console.log(`aliases=${by('alias')}  descriptions=${JSON.stringify(by('desc'))}`);
console.log(`update-match confidence: ${JSON.stringify(by('conf'))}`);
const faults = rows.filter((r) => r.err !== 0);
console.log(`fatal errors: ${faults.length ? faults.map((r) => `${r.uid}=${r.err}`).join(', ') : 'none'}\n`);

// ---------------------------------------------------------------- 4. ping
console.log('[4] Ping round-trip on 5 motors (10-byte echo)');
for (const m of present.slice(0, 5)) {
  const payload = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const t = Date.now();
  const [echo] = await bus.send(m.uniqueId, 31, payload);
  const same = echo.length === 10 && payload.every((b, i) => echo[i] === b);
  console.log(`    ${idHex(m.uniqueId)}  ${same ? 'echo OK' : 'ECHO MISMATCH'}  ${Date.now() - t} ms`);
}
console.log();

// ---------------------------------------------------------------- 5. identify
console.log('[5] Identify (LED only — 30 green flashes, no motion)');
const target = present[0];
await ops.identify(bus, target.uniqueId);
console.log(`    ${idHex(target.uniqueId)} should be flashing now`);
await sleep(3000);
console.log('    broadcast identify — every motor flashes');
await bus.send(255, 41, undefined, { expectResponse: false });
await sleep(3000);
console.log();

// ---------------------------------------------------------------- 6. reset
console.log('[6] Targeted reset + re-read');
await fleet.reset(target);
console.log(`    ${idHex(target.uniqueId)} back with fw ${target.firmwareVersion?.join('.')}, ` +
            `fatal=${target.status?.fatalErrorCode}, ${target.voltage} V\n`);

// ---------------------------------------------------------------- 7. stress
console.log('[7] Communication reliability: 200 queries round-robin');
let ok = 0, fail = 0; const lat = [];
for (let i = 0; i < 200; i++) {
  const m = present[i % present.length];
  const t = Date.now();
  try { await ops.getStatus(bus, m.uniqueId); ok++; lat.push(Date.now() - t); }
  catch (e) { fail++; if (fail <= 3) console.log(`    fail: ${e.constructor.name} ${e.message}`); }
}
lat.sort((a, b) => a - b);
console.log(`    ${ok} ok, ${fail} failed · latency min ${lat[0]} / median ${lat[lat.length >> 1]} / max ${lat.at(-1)} ms\n`);

await bus.close();
console.log('=== done — no motor was energised or moved ===');
process.exit(0);
