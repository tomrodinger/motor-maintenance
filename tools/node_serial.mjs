// node_serial.mjs — presents a POSIX tty as a Web Serial-shaped port so the
// app's real modules (protocol.js / serial.js / fleet.js) can be driven from
// Node against actual hardware. Baud and line discipline are set with stty;
// Node then just reads and writes the character device.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export class NodeSerialPort {
  constructor(path) { this.path = path; this.fd = null; }

  getInfo() { return { path: this.path, node: true }; }

  async open({ baudRate = 230400 } = {}) {
    // Order matters on macOS: a tty reverts to its default line settings when the
    // last fd closes, and `stty -f` opens and closes the device itself. Hold our
    // own fd open first so the settings survive.
    // O_NONBLOCK is essential too: a blocking read on a tty parks a libuv
    // threadpool worker forever and wedges the process.
    this.fd = fs.openSync(this.path, fs.constants.O_RDWR | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY);
    execFileSync('stty', ['-f', this.path, String(baudRate), 'raw', '-echo', '-echoe',
      '-echok', '-echoctl', '-echoke', '-crtscts', '-ixon', '-ixoff', 'cs8', '-parenb', '-cstopb']);
    const speed = execFileSync('stty', ['-f', this.path, '-a']).toString();
    if (!speed.includes(`speed ${baudRate} baud`)) {
      throw new Error(`Could not set ${baudRate} baud on ${this.path} (got: ${speed.split(';')[0]})`);
    }
    this._closed = false;

    this.readable = new ReadableStream({
      start: (controller) => {
        const buf = Buffer.allocUnsafe(4096);
        const pump = () => {
          if (this._closed) { try { controller.close(); } catch {} return; }
          fs.read(this.fd, buf, 0, buf.length, null, (err, n) => {
            if (this._closed) { try { controller.close(); } catch {} return; }
            if (err) {
              // EAGAIN on an idle tty is normal; back off and retry.
              if (err.code === 'EAGAIN') return setTimeout(pump, 2);
              try { controller.error(err); } catch {}
              return;
            }
            if (n > 0) controller.enqueue(new Uint8Array(buf.subarray(0, n)));
            setImmediate(pump);
          });
        };
        pump();
      },
      cancel: () => { this._closed = true; },
    });

    this.writable = new WritableStream({
      write: (chunk) => new Promise((resolve, reject) => {
        fs.write(this.fd, Buffer.from(chunk), (err) => (err ? reject(err) : resolve()));
      }),
    });
  }

  async close() {
    this._closed = true;
    await new Promise((r) => setTimeout(r, 20));
    if (this.fd != null) { try { fs.closeSync(this.fd); } catch {} this.fd = null; }
  }
}

export function listPorts() {
  return fs.readdirSync('/dev')
    .filter((n) => n.startsWith('cu.usbserial') || n.startsWith('cu.usbmodem'))
    .map((n) => `/dev/${n}`)
    .sort();
}
