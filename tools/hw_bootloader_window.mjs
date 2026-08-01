// hw_bootloader_window.mjs — can JS hit the bootloader window reliably?
//
// After a System reset the device runs its bootloader for ~250 ms and then
// launches the application, UNLESS an addressed packet with a valid CRC arrives
// inside that window, which pins it in the bootloader. upgrade_firmware.py waits
// 70 ms before the first page. This measures whether setTimeout can actually land
// there, WITHOUT WRITING ANY FLASH: it resets, waits, sends a harmless query, and
// asks the device whether it ended up in the bootloader.

import { Bus } from '../docs/js/serial.js';
import { ops } from '../docs/js/commands.js';
import { NodeSerialPort } from './node_serial.mjs';

const PORT = process.argv[2] || '/dev/cu.usbserial-110';
const TRIALS = Number(process.argv[3] || 10);
const DELAY = Number(process.argv[4] || 70);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bus = new Bus();
bus.logging = false;
await bus.open(new NodeSerialPort(PORT));

// Pick one motor to experiment on, addressed by unique ID so the other 34 are
// untouched.
await ops.systemReset(bus, 255);
await sleep(1500);
bus.flushInput();
const devices = await ops.detectDevices(bus);
if (!devices.length) { console.log('no motors found'); process.exit(1); }
const target = devices[0].uniqueId;
console.log(`Target motor: ${target.toString(16).toUpperCase().padStart(16, '0')}`);
console.log(`${TRIALS} trials, ${DELAY} ms delay after reset\n`);

let hits = 0;
const actual = [];
for (let i = 1; i <= TRIALS; i++) {
  // Reset just this motor and try to catch it in its bootloader.
  await bus.send(target, 27, undefined, { expectResponse: true });
  const t0 = performance.now();
  await sleep(DELAY);
  const waited = performance.now() - t0;
  actual.push(waited);

  let inBoot = null, version = null;
  try {
    const r = await ops.getFirmwareVersion(bus, target);
    inBoot = r.inBootloader;
    version = r.version.join('.');
  } catch (e) {
    inBoot = `error: ${e.constructor.name}`;
  }
  if (inBoot === true) hits++;
  console.log(`  trial ${String(i).padStart(2)}: slept ${waited.toFixed(1)} ms -> ` +
              `${inBoot === true ? `IN BOOTLOADER (v${version})` : inBoot === false ? `in application (v${version})` : inBoot}`);

  // Return it to the application before the next trial.
  await bus.send(target, 27, undefined, { expectResponse: true });
  await sleep(1500);
}

actual.sort((a, b) => a - b);
console.log(`\nCaught the bootloader ${hits}/${TRIALS} times`);
console.log(`setTimeout(${DELAY}) actually slept: min ${actual[0].toFixed(1)} / ` +
            `median ${actual[actual.length >> 1].toFixed(1)} / max ${actual.at(-1).toFixed(1)} ms ` +
            `(must stay under ~250 ms)`);

// Leave everything in the application.
await ops.systemReset(bus, 255);
await sleep(1500);
await bus.close();
process.exit(0);
