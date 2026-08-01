// hw_unicast_flash.mjs — can a single motor be flashed by unique ID?
//
// An earlier session concluded "no": a unicast Firmware upgrade page produced no
// response and no write. But that test ran BEFORE the chunked-write fix, and the
// packet was sent as one 2069-byte burst — which we later proved is dropped by
// the device even when broadcast. So the earlier conclusion may have been an
// artifact of that bug rather than a real protocol limit. Re-test properly.
//
// Stage 1 is zero-risk: send a page for a model that is not on this bus. The
// bootloader must reject the write, but if it RECEIVED the packet it will stay in
// the bootloader (any addressed valid-CRC packet cancels the app launch).
// Stage 2 does a real single-motor downgrade and checks the other 34 are untouched.

import { Bus } from '../docs/js/serial.js';
import { Fleet, idHex } from '../docs/js/fleet.js';
import { ops, CMD, u8 } from '../docs/js/commands.js';
import * as fw from '../docs/js/firmware.js';
import { concat } from '../docs/js/protocol.js';
import { NodeSerialPort } from './node_serial.mjs';

const PORT = process.argv[2] || '/dev/cu.usbserial-110';
const OLD = process.argv[3] || 'servomotor_M17_fw0.15.3.4_scc3_hw1.5.firmware';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bus = new Bus();
bus.logging = false;
const fleet = new Fleet(bus);
await bus.open(new NodeSerialPort(PORT));
await fleet.loadReleaseIndex();

console.log('Scanning...');
await fleet.scan({ enrich: false });
const present = fleet.list.filter((m) => m.present);
for (const m of present) await fleet.refresh(m);
const target = present[0];
console.log(`${present.length} motors. Target: ${idHex(target.uniqueId)} on ${target.firmwareVersion.join('.')}\n`);

const page = (model, scc, pageNo, fill) => {
  const p = new Uint8Array(8 + 1 + 1 + fw.FLASH_PAGE_SIZE);
  p.set(new TextEncoder().encode(model.padEnd(8, ' ')), 0);
  p[8] = scc; p[9] = pageNo; p.fill(fill, 10);
  return p;
};

// ---------------------------------------------------------------- stage 1
console.log('[1] Zero-risk receive test: unicast a page for model "M3" (none on this bus).');
console.log('    If the motor stays in the bootloader, it received and processed the packet.');
for (const label of ['unicast by unique ID', 'broadcast (control)']) {
  const addr = label.startsWith('unicast') ? target.uniqueId : 255;
  await bus.send(addr, CMD.SYSTEM_RESET, undefined, { expectResponse: addr !== 255 });
  await sleep(fw.WAIT_FOR_RESET_MS);
  let acked = 'no response';
  try {
    const r = await bus.send(addr, CMD.FIRMWARE_UPGRADE, page('M3', 3, 30, 0xAA),
      { expectResponse: addr !== 255, timeout: 2500 });
    acked = addr === 255 ? 'n/a (broadcast)' : `responded (${r.length} frame(s))`;
  } catch (e) { acked = e.constructor.name; }
  await sleep(250);
  let boot = '?';
  try { boot = (await ops.getFirmwareVersion(bus, target.uniqueId)).inBootloader; } catch (e) { boot = e.constructor.name; }
  console.log(`    ${label.padEnd(22)} page ack: ${String(acked).padEnd(22)} still in bootloader: ${boot}`);
  await bus.send(255, CMD.SYSTEM_RESET, undefined, { expectResponse: false });
  await sleep(1500);
}

// ---------------------------------------------------------------- stage 2
console.log(`\n[2] Real single-motor downgrade to ${OLD}, addressed by unique ID.`);
const rel = fleet.releases.find((r) => r.name === OLD);
const parsed = fw.parseFirmwareFile(await fw.downloadFirmware(rel));
const before = new Map(present.map((m) => [idHex(m.uniqueId), m.firmwareVersion.join('.')]));

await bus.send(target.uniqueId, CMD.SYSTEM_RESET, undefined, { expectResponse: true });
await sleep(fw.WAIT_FOR_RESET_MS);
let acks = 0, fails = 0;
for (let i = 0; i < parsed.pages; i++) {
  const pageNumber = fw.FIRST_FIRMWARE_PAGE + i;
  const slice = parsed.payload.subarray(i * fw.FLASH_PAGE_SIZE, (i + 1) * fw.FLASH_PAGE_SIZE);
  const buf = new Uint8Array(fw.FLASH_PAGE_SIZE);
  buf.set(slice);
  const body = concat(parsed.modelCode, u8(parsed.compatibilityCode), u8(pageNumber), buf);
  try {
    await bus.send(target.uniqueId, CMD.FIRMWARE_UPGRADE, body, { expectResponse: true, timeout: 2500 });
    acks++;
  } catch { fails++; await sleep(fw.DELAY_AFTER_EACH_PAGE_MS); }
  process.stdout.write(`\r    page ${i + 1}/${parsed.pages}  acked ${acks}  timed out ${fails}   `);
}
await bus.send(target.uniqueId, CMD.SYSTEM_RESET, undefined, { expectResponse: true }).catch(() => {});
await sleep(1500);
console.log();

// ---------------------------------------------------------------- verify
console.log('\n[3] Verifying');
await fleet.scan({ enrich: false });
const after = fleet.list.filter((m) => m.present);
for (const m of after) await fleet.refresh(m);
const tgt = after.find((m) => m.uniqueId === target.uniqueId);
console.log(`    target ${idHex(target.uniqueId)}: ${before.get(idHex(target.uniqueId))} -> ${tgt?.firmwareVersion.join('.')}`);
const changed = after.filter((m) => m.uniqueId !== target.uniqueId &&
  before.get(idHex(m.uniqueId)) !== m.firmwareVersion.join('.'));
console.log(`    other motors changed: ${changed.length}${changed.length ? ' -> ' + changed.map((m) => idHex(m.uniqueId)).join(', ') : ''}`);
const worked = tgt?.firmwareVersion.join('.') === rel.version.join('.') && changed.length === 0;
console.log(`\n    ${worked ? 'UNICAST FIRMWARE UPGRADE WORKS' : 'unicast upgrade did NOT take effect'}`);

// ---------------------------------------------------------------- restore
if (tgt && tgt.firmwareVersion.join('.') !== '0.15.9.0') {
  console.log('\n[4] Restoring 0.15.9.0 by broadcast');
  const latest = fleet.releases.find((r) => r.name === 'servomotor_M17_fw0.15.9.0_scc3_hw1.5.firmware');
  const p2 = fw.parseFirmwareFile(await fw.downloadFirmware(latest));
  await fw.flashFirmware(bus, p2, { onProgress: (p) => { if (p.phase === 'write') process.stdout.write(`\r    page ${p.page}/${p.pages}  `); } });
  await fleet.scan({ enrich: false });
  const fin = fleet.list.filter((m) => m.present);
  for (const m of fin) await fleet.refresh(m);
  const vs = {};
  for (const m of fin) vs[m.firmwareVersion.join('.')] = (vs[m.firmwareVersion.join('.')] || 0) + 1;
  console.log(`\n    restored: ${fin.length} motors ${JSON.stringify(vs)}`);
}

await bus.close();
process.exit(0);
