// sim_firmware.mjs — exercise the firmware paths against the simulator, headless.
// Covers what the browser would do: compatible-release listing, a targeted
// single-motor flash, and a broadcast flash of a whole model group.

import { Bus } from '../docs/js/serial.js';
import { Fleet, idHex } from '../docs/js/fleet.js';
import { SimulatedPort, demoMotors } from '../docs/js/simulator.js';

const bus = new Bus();
bus.logging = false;
const fleet = new Fleet(bus);
await bus.open(new SimulatedPort(demoMotors()));
await fleet.loadReleaseIndex();

console.log('Scanning the simulated bus...');
await fleet.scan();
const present = fleet.list.filter((m) => m.present);
const show = () => present.map((m) => `${m.info.productCode}/${idHex(m.uniqueId).slice(-6)}=${m.firmwareVersion.join('.')}`).join('  ');
console.log(`${present.length} motors: ${show()}\n`);

// ------------------------------------------------------------- listing
console.log('[1] compatibleReleases per motor');
for (const m of present) {
  const rs = fleet.compatibleReleases(m);
  const cur = rs.filter((r) => r.isCurrent).map((r) => r.versionStr);
  const newer = rs.filter((r) => r.isNewer).length;
  console.log(`    ${m.info.productCode} scc${m.info.firmwareCompatibility} hw${m.info.hardwareVersion}: ` +
              `${rs.length} builds, ${newer} newer, installed=${cur.join(',') || 'none listed'}, ` +
              `hw-mismatched=${rs.filter((r) => !r.hardwareMatches).length}`);
}

// ------------------------------------------------------------- targeted
console.log('\n[2] Targeted flash of ONE motor (unicast by unique ID)');
const one = present.find((m) => m.info.productCode === 'M17');
const older = fleet.compatibleReleases(one).find((r) => r.versionStr === '0.15.1.0');
const othersBefore = present.filter((m) => m !== one).map((m) => m.firmwareVersion.join('.'));
await fleet.upgrade([one], { release: older, onProgress: (p) => {
  if (p.phase === 'write' && p.page === 1) console.log(`    writing ${p.pages} pages, broadcast=${p.broadcast}`);
} });
console.log(`    target now ${one.firmwareVersion.join('.')} (expected ${older.versionStr})`);
const othersAfter = present.filter((m) => m !== one).map((m) => m.firmwareVersion.join('.'));
console.log(`    others unchanged: ${JSON.stringify(othersBefore) === JSON.stringify(othersAfter)}`);

// ------------------------------------------------------------- broadcast
console.log('\n[3] Broadcast flash of every M17 (what the broadcast card does)');
const m17s = present.filter((m) => m.info.productCode === 'M17' && m.info.firmwareCompatibility === 3);
const pick = fleet.compatibleReleases(m17s[0]).find((r) => r.versionStr === '0.15.9.0');
console.log(`    ${m17s.length} M17s currently on ${[...new Set(m17s.map((m) => m.firmwareVersion.join('.')))].join(', ')}`);
await fleet.upgrade(m17s, { release: pick, onProgress: (p) => {
  if (p.phase === 'write' && p.page === 1) console.log(`    writing ${p.pages} pages, broadcast=${p.broadcast}`);
} });
console.log(`    M17s now on ${[...new Set(m17s.map((m) => m.firmwareVersion.join('.')))].join(', ')} (expected ${pick.versionStr})`);

console.log(`\nfinal: ${show()}`);
const ok = m17s.every((m) => m.firmwareVersion.join('.') === pick.version.join('.'));
console.log(ok ? '\nFIRMWARE PATHS OK' : '\nPROBLEM');
await bus.close();
process.exit(ok ? 0 : 1);
