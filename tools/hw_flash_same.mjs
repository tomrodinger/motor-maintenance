// hw_flash_same.mjs — full broadcast flash of the version the motors already run.
// Exercises the entire write path end to end; the end state equals the start
// state, so a success changes nothing and a failure is recoverable by re-running.

import { Bus } from '../docs/js/serial.js';
import { Fleet, idHex } from '../docs/js/fleet.js';
import * as fw from '../docs/js/firmware.js';
import { NodeSerialPort } from './node_serial.mjs';

const PORT = process.argv[2] || '/dev/cu.usbserial-110';
const NAME = process.argv[3] || 'servomotor_M17_fw0.15.9.0_scc3_hw1.5.firmware';

const bus = new Bus();
bus.logging = false;
const fleet = new Fleet(bus);
fleet.addEventListener('warning', (e) => console.log(`  ! ${e.detail.message}`));

await bus.open(new NodeSerialPort(PORT));
await fleet.loadReleaseIndex();

console.log('Scanning...');
await fleet.scan({ enrich: false });
const before = fleet.list.filter((m) => m.present);
for (const m of before) await fleet.refresh(m);
const tally = (list) => {
  const t = {};
  for (const m of list) t[m.firmwareVersion?.join('.') ?? '?'] = (t[m.firmwareVersion?.join('.') ?? '?'] || 0) + 1;
  return t;
};
console.log(`${before.length} motors before: ${JSON.stringify(tally(before))}`);
console.log(`fatal errors before: ${before.filter((m) => m.status?.fatalErrorCode).length}\n`);

const release = fleet.releases.find((r) => r.name === NAME);
const bytes = await fw.downloadFirmware(release);
const parsed = fw.parseFirmwareFile(bytes);
console.log(`Flashing ${release.name}`);
console.log(`  ${parsed.modelName}/scc${parsed.compatibilityCode}, ${parsed.pages} pages, ` +
            `${parsed.payload.length} bytes, image CRC ${parsed.imageCrc.toString(16).toUpperCase()}`);
console.log(`  broadcast — every M17/scc3 on the bus is written\n`);

const t0 = Date.now();
await fw.flashFirmware(bus, parsed, {
  onProgress: (p) => {
    if (p.phase === 'write') process.stdout.write(`\r  page ${p.page}/${p.pages} (flash page ${p.pageNumber})   `);
    else process.stdout.write(`\r  ${p.phase}...`.padEnd(40));
  },
});
console.log(`\r  wrote ${parsed.pages} pages in ${((Date.now() - t0) / 1000).toFixed(1)} s`.padEnd(45));

console.log('\nRe-scanning...');
await fleet.scan({ enrich: false });
const after = fleet.list.filter((m) => m.present);
for (const m of after) await fleet.refresh(m);
console.log(`${after.length} motors after: ${JSON.stringify(tally(after))}`);

const faults = after.filter((m) => m.status?.fatalErrorCode);
const boot = after.filter((m) => m.inBootloader);
const wrong = after.filter((m) => m.firmwareVersion?.join('.') !== release.version.join('.'));
console.log(`fatal errors: ${faults.length}${faults.length ? ' -> ' + faults.map((m) => idHex(m.uniqueId)).join(', ') : ''}`);
console.log(`stuck in bootloader: ${boot.length}`);
console.log(`wrong version: ${wrong.length}`);

const lost = before.filter((b) => !after.some((a) => a.uniqueId === b.uniqueId));
console.log(`no longer responding: ${lost.length}${lost.length ? ' -> ' + lost.map((m) => idHex(m.uniqueId)).join(', ') : ''}`);

const ok = after.length === before.length && !faults.length && !boot.length && !wrong.length && !lost.length;
console.log(`\n${ok ? 'PASS — all motors came back on the expected version' : 'PROBLEM — see above'}`);

await bus.close();
process.exit(ok ? 0 : 1);
