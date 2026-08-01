// repeat_scan.mjs — is the adaptive scan repeatable on a crowded bus?
import { Bus } from '../docs/js/serial.js';
import { Fleet } from '../docs/js/fleet.js';
import { NodeSerialPort } from './node_serial.mjs';
const bus = new Bus(); bus.logging = false;
const fleet = new Fleet(bus);
await bus.open(new NodeSerialPort(process.argv[2] || '/dev/cu.usbserial-110'));
const N = Number(process.argv[3] || 3);
for (let i = 1; i <= N; i++) {
  fleet.motors.clear();
  let passes = 0;
  const h = (e) => { if (e.detail.label.startsWith('Resetting')) passes++; };
  fleet.addEventListener('scan-progress', h);
  const t = Date.now();
  await fleet.scan({ enrich: false });
  fleet.removeEventListener('scan-progress', h);
  const n = fleet.list.filter((m) => m.present).length;
  console.log(`scan ${i}: ${n} motors, ${passes} passes, ${((Date.now()-t)/1000).toFixed(1)} s` +
              `  (framer discarded ${bus.framer.droppedBytes} corrupt bytes total)`);
}
await bus.close(); process.exit(0);
