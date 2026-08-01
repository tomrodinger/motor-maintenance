// hw_repro_flash.mjs — does a firmware upgrade leave motors alive but unreachable?
//
// In the first session the "8 motors silent" fault appeared immediately after a
// downgrade+upgrade round trip, and unlike anything reproducible since, those
// motors stayed silent for ~10 minutes across many processes AND did not answer
// direct unique-ID queries. Alive tests alone do not reproduce it. This replays
// the one untested trigger.

import { Bus } from '../docs/js/serial.js';
import { Fleet, idHex } from '../docs/js/fleet.js';
import { ops } from '../docs/js/commands.js';
import * as fw from '../docs/js/firmware.js';
import { NodeSerialPort } from './node_serial.mjs';

const PORT = process.argv[2] || '/dev/cu.usbserial-110';
const TARGET_FW = process.argv[3] || 'servomotor_M17_fw0.15.3.4_scc3_hw1.5.firmware';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bus = new Bus();
bus.logging = false;
const fleet = new Fleet(bus);
await bus.open(new NodeSerialPort(PORT));
await fleet.loadReleaseIndex();

const scanIds = async () => {
  bus.rxBytes = 0; bus.errorFrames = [];
  await ops.systemReset(bus, 255);
  await sleep(1500);
  bus.flushInput();
  const d = await ops.detectDevices(bus);
  return { ids: new Set(d.map((x) => idHex(x.uniqueId))), rx: bus.rxBytes, errs: bus.errorFrames.length };
};

const multiScan = async (label, n = 4) => {
  const all = new Set();
  for (let i = 0; i < n; i++) {
    const r = await scanIds();
    all.add.bind(all);
    r.ids.forEach((x) => all.add(x));
    console.log(`  ${label} pass ${i + 1}: ${r.ids.size} found, ${r.rx}B rx, ${r.errs} error packets`);
    await sleep(300);
  }
  console.log(`  ${label} cumulative: ${all.size}\n`);
  return all;
};

console.log('[0] Before the flash');
const before = await multiScan('before');

console.log(`[1] Broadcast-flashing ${TARGET_FW}`);
const rel = fleet.releases.find((r) => r.name === TARGET_FW);
const parsed = fw.parseFirmwareFile(await fw.downloadFirmware(rel));
const t = Date.now();
await fw.flashFirmware(bus, parsed, {
  onProgress: (p) => { if (p.phase === 'write') process.stdout.write(`\r  page ${p.page}/${p.pages}  `); },
});
console.log(`\r  ${parsed.pages} pages in ${((Date.now() - t) / 1000).toFixed(1)} s\n`.padEnd(40));

console.log('[2] Immediately after the flash');
const after = await multiScan('after', 5);

const lost = [...before].filter((x) => !after.has(x));
console.log('=== result ===');
console.log(`before ${before.size}, after ${after.size}, lost ${lost.length}`);
if (lost.length) {
  console.log('\nREPRODUCED — motors present before the flash and silent after:');
  for (const id of lost) console.log(`  ${id}`);
  console.log('\nProbing each directly by unique ID:');
  for (const id of lost) {
    let a = 'silent', b = 'silent';
    try { const r = await ops.getFirmwareVersion(bus, BigInt('0x' + id)); a = `v${r.version.join('.')} boot=${r.inBootloader}`; }
    catch (e) { a = e.constructor.name; }
    try { const s = await ops.getStatus(bus, BigInt('0x' + id)); b = `flags=${s.raw} fatal=${s.fatalErrorCode}`; }
    catch (e) { b = e.constructor.name; }
    console.log(`  ${id}  fwVersion=${a}  status=${b}`);
  }
} else {
  console.log('Not reproduced by the flash alone.');
}

// Always leave the rack on the latest firmware.
console.log('\n[3] Restoring the latest firmware');
const latest = fleet.releases.filter((r) => r.model === 'M17' && r.scc === 3 && r.hardware === '1.5')
  .sort((a, b) => fw.compareVersion(b.version, a.version))[0];
const p2 = fw.parseFirmwareFile(await fw.downloadFirmware(latest));
await fw.flashFirmware(bus, p2, {
  onProgress: (p) => { if (p.phase === 'write') process.stdout.write(`\r  page ${p.page}/${p.pages}  `); },
});
const final = await multiScan(`restored ${latest.versionStr}`, 3);
console.log(`final: ${final.size} motors on ${latest.versionStr}`);

await bus.close();
process.exit(0);
