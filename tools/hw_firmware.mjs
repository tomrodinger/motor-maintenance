// hw_firmware.mjs — full product round-trip on real hardware.
//
//   1. broadcast-write an OLDER release to the whole bus
//   2. rescan and confirm the app now reports an update is available
//   3. call Fleet.upgrade() — the exact path the Update button uses
//   4. confirm every motor is back on the latest
//
// Recovery: only flash pages 5+ are written and the bootloader in pages 0-4 is
// never touched, so a failed write leaves the bootloader holding a bad
// application CRC and the motor can always be re-flashed by re-running this.

import { Bus } from '../docs/js/serial.js';
import { Fleet, idHex } from '../docs/js/fleet.js';
import * as fw from '../docs/js/firmware.js';
import { NodeSerialPort } from './node_serial.mjs';

const PORT = process.argv[2] || '/dev/cu.usbserial-110';
const OLD = process.argv[3] || 'servomotor_M17_fw0.15.3.4_scc3_hw1.5.firmware';

const bus = new Bus();
bus.logging = false;
const fleet = new Fleet(bus);
fleet.addEventListener('warning', (e) => console.log(`  ! ${e.detail.message}`));

const tally = (list) => {
  const t = {};
  for (const m of list) t[m.firmwareVersion?.join('.') ?? '?'] = (t[m.firmwareVersion?.join('.') ?? '?'] || 0) + 1;
  return t;
};
const survey = async () => {
  await fleet.scan({ enrich: false });
  const present = fleet.list.filter((m) => m.present);
  for (const m of present) await fleet.refresh(m);
  return present;
};

await bus.open(new NodeSerialPort(PORT));
await fleet.loadReleaseIndex();

console.log('Baseline scan...');
let motors = await survey();
console.log(`  ${motors.length} motors: ${JSON.stringify(tally(motors))}`);
console.log(`  update available on ${motors.filter((m) => m.updateAvailable).length}\n`);

// ------------------------------------------------------------------ downgrade
const old = fleet.releases.find((r) => r.name === OLD);
console.log(`[1] Broadcast-writing the older ${old.versionStr} to the whole bus`);
const parsed = fw.parseFirmwareFile(await fw.downloadFirmware(old));
let t = Date.now();
await fw.flashFirmware(bus, parsed, {
  onProgress: (p) => { if (p.phase === 'write') process.stdout.write(`\r    page ${p.page}/${p.pages}   `); },
});
console.log(`\r    ${parsed.pages} pages in ${((Date.now() - t) / 1000).toFixed(1)} s`.padEnd(40));

console.log('\n[2] Rescanning — does the app notice they are out of date?');
motors = await survey();
const stale = motors.filter((m) => m.updateAvailable);
console.log(`    ${motors.length} motors: ${JSON.stringify(tally(motors))}`);
console.log(`    updateAvailable on ${stale.length}/${motors.length}`);
console.log(`    target version the app picked: ${[...new Set(stale.map((m) => m.firmware.release.versionStr))].join(', ')}`);
console.log(`    match confidence: ${[...new Set(stale.map((m) => m.firmware.confidence))].join(', ')}`);
console.log(`    fatal errors: ${motors.filter((m) => m.status?.fatalErrorCode).length}\n`);

// ------------------------------------------------------------------ upgrade
console.log('[3] Fleet.upgrade() — the code path behind the Update button');
t = Date.now();
const results = await fleet.upgrade(stale, {
  onProgress: (p) => {
    if (p.stage === 'flash' && p.phase === 'write') process.stdout.write(`\r    writing ${p.label} page ${p.page}/${p.pages}   `);
    else process.stdout.write(`\r    ${p.stage}: ${p.label ?? ''}`.padEnd(60));
  },
});
console.log(`\r    finished in ${((Date.now() - t) / 1000).toFixed(1)} s`.padEnd(60));
console.log(`    verified ${results.filter((r) => r.ok).length}/${results.length} motors on ${results[0]?.expected}`);
const bad = results.filter((r) => !r.ok);
for (const r of bad) console.log(`    MISMATCH ${idHex(r.motor.uniqueId)}: got ${r.actual}`);

// ------------------------------------------------------------------ final
console.log('\n[4] Final independent scan');
motors = await survey();
console.log(`    ${motors.length} motors: ${JSON.stringify(tally(motors))}`);
console.log(`    fatal errors: ${motors.filter((m) => m.status?.fatalErrorCode).length}`);
console.log(`    stuck in bootloader: ${motors.filter((m) => m.inBootloader).length}`);
console.log(`    still needing an update: ${motors.filter((m) => m.updateAvailable).length}`);

const ok = motors.length === 35 && !bad.length &&
           !motors.filter((m) => m.status?.fatalErrorCode || m.inBootloader || m.updateAvailable).length;
console.log(`\n${ok ? 'PASS — full downgrade/upgrade round trip on all 35 motors' : 'PROBLEM — see above'}`);

await bus.close();
process.exit(ok ? 0 : 1);
