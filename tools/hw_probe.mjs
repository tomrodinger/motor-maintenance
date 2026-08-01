// hw_probe.mjs — find which adapter has motors on it.
// Sends only silent commands: System reset and Detect devices. No motion.

import { Bus } from '../docs/js/serial.js';
import { ops } from '../docs/js/commands.js';
import { NodeSerialPort, listPorts } from './node_serial.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idHex = (id) => id.toString(16).toUpperCase().padStart(16, '0');

const only = process.argv[2];
const ports = only ? [only] : listPorts();
console.log(`Probing ${ports.length} port(s): ${ports.join(', ')}\n`);

for (const path of ports) {
  const bus = new Bus();
  bus.logging = false;
  const port = new NodeSerialPort(path);
  process.stdout.write(`${path.padEnd(26)} `);
  try {
    await bus.open(port);
  } catch (e) {
    console.log(`could not open: ${e.message}`);
    continue;
  }

  try {
    await ops.systemReset(bus, 255);
    await sleep(1500);
    bus.flushInput();
    const t0 = Date.now();
    const found = await ops.detectDevices(bus);
    const ms = Date.now() - t0;
    if (!found.length) {
      console.log(`no reply (${ms} ms)`);
    } else {
      console.log(`${found.length} motor(s) replied in ${ms} ms`);
      for (const d of found.slice(0, 40)) {
        console.log(`    ${idHex(d.uniqueId)}  alias ${d.alias === 255 ? 'none' : d.alias}`);
      }
    }
  } catch (e) {
    console.log(`error: ${e.constructor.name}: ${e.message}`);
  } finally {
    await bus.close();
    await sleep(150);
  }
}
process.exit(0);
