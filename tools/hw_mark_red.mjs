// hw_mark_red.mjs — light the red LED on every motor we can detect, so the
// unreachable ones stand out physically.
//
// Test mode 12 = red LED on. The firmware sends the success response and then
// disables interrupts and busy-loops forever (firmware/Src/main.c
// set_led_test_mode). The motor is unreachable afterwards and NOT recoverable by
// System reset — only a power cycle. That is acceptable here because a power
// cycle is planned anyway.
//
//   mode "unicast"   (default) — address the detected motors one by one.
//                    Result: detected motors go solid red, undetected ones keep
//                    blinking green.
//   mode "broadcast" — send once to address 255. Any motor still LISTENING obeys,
//                    whether or not it can talk back. If a motor that we could
//                    not detect turns red, it can receive but not transmit, which
//                    localises the fault to its transmit path rather than the
//                    whole node.

import { Bus } from '../docs/js/serial.js';
import { Fleet, idHex } from '../docs/js/fleet.js';
import { ops, CMD, u8 } from '../docs/js/commands.js';
import { NodeSerialPort } from './node_serial.mjs';
import { writeFileSync } from 'node:fs';

const PORT = process.argv[2] || '/dev/cu.usbserial-110';
const MODE = process.argv[3] || 'unicast';
const TEST_MODE_RED_LED_ON = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bus = new Bus();
bus.logging = false;
const fleet = new Fleet(bus);
await bus.open(new NodeSerialPort(PORT));

if (MODE === 'broadcast') {
  console.log('Broadcasting Test mode 12 (red LED on) to address 255.');
  console.log('Every motor that can still RECEIVE will go red, detectable or not.\n');
  await bus.send(255, CMD.TEST_MODE, u8(TEST_MODE_RED_LED_ON), { expectResponse: false });
  await sleep(500);
  console.log('Sent. Any motor still blinking green cannot receive either.');
  await bus.close();
  process.exit(0);
}

console.log('Scanning to establish exactly which motors are reachable...');
await fleet.scan({ enrich: false });
const present = fleet.list.filter((m) => m.present);
const ids = present.map((m) => idHex(m.uniqueId)).sort();
console.log(`${present.length} motors reachable\n`);

writeFileSync('detected_before_power_cycle.txt', ids.join('\n') + '\n');
console.log('Saved the list to tools/detected_before_power_cycle.txt for comparison afterwards.\n');

console.log('Lighting the red LED on each one (each motor hangs immediately after acknowledging):');
let ok = 0;
const failed = [];
for (const m of present) {
  try {
    // The device answers, then hangs. A short timeout is enough.
    await bus.send(m.uniqueId, CMD.TEST_MODE, u8(TEST_MODE_RED_LED_ON), { timeout: 600 });
    ok++;
    process.stdout.write(`\r  ${ok}/${present.length} lit   `);
  } catch (e) {
    failed.push({ id: idHex(m.uniqueId), why: e.constructor.name });
  }
}
console.log(`\r  ${ok}/${present.length} motors acknowledged and are now solid red`.padEnd(60));
if (failed.length) {
  console.log(`  ${failed.length} did not acknowledge:`);
  for (const f of failed) console.log(`    ${f.id} (${f.why})`);
}

console.log(`\nWalk the rack: solid red = reachable, still blinking green = one of the ${35 - ok} we cannot reach.`);
console.log('All red motors are now hung and need the power cycle to come back.');

await bus.close();
process.exit(0);
