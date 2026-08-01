// simulator.js — a fake RS485 bus with fake motors on it.
//
// It implements just enough of the SerialPort interface for Bus to open it, and
// it speaks the real wire protocol: every byte that goes in and out is encoded
// and decoded exactly as the hardware would. That makes demo mode a genuine
// end-to-end test of the protocol stack, not a mock of the UI.

import {
  ALL_ALIAS, EXTENDED_ADDRESSING, RESPONSE_CHAR_CRC32_ENABLED,
  EXTENDED_SIZE_SENTINEL, concat, crc32,
} from './protocol.js';
import { CMD } from './commands.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SimMotor {
  constructor(cfg) {
    Object.assign(this, {
      uniqueId: 0n, alias: 255, productCode: 'M17', scc: 3, hardwareVersion: '1.5',
      firmwareVersion: [0, 15, 3, 0], serialNumber: 100001,
      countsPerRotation: 3276800, updateFrequency: 31250,
      voltage: 241, temperature: 0, ...cfg,
    });
    this.reset();
  }

  reset() {
    this.mosfets = false;
    this.position = 0n;
    this.queued = 0;
    this.fatalError = 0;
    this.moveEndsAt = 0;
    this.flashedPages = new Set();
  }

  /**
   * Enter the bootloader for its ~250 ms window. The application starts when the
   * window expires, unless a packet arrives first — which is exactly how a real
   * upgrade keeps the device there, and exactly how stray bus traffic strands it.
   */
  enterBootloader() {
    this.inBootloader = true;
    clearTimeout(this._bootTimer);
    this._bootTimer = setTimeout(() => {
      this._bootTimer = null;
      this.inBootloader = false;   // application launched
    }, SimMotor.BOOTLOADER_WINDOW_MS);
  }

  /** Any addressed packet inside the window cancels the launch. */
  noteTraffic() {
    if (this.inBootloader && this._bootTimer) {
      clearTimeout(this._bootTimer);
      this._bootTimer = null;
    }
  }

  static BOOTLOADER_WINDOW_MS = 250;
  static BOOTLOADER_VERSION = [1, 1, 1, 0];   // major.minor.patch.dev

  get statusFlags() {
    let f = 0;
    if (this.mosfets) f |= 1 << 1;
    if (this.queued > 0) f |= 0; // ordinary queued motion is not a status flag
    return f;
  }

  tick() {
    if (this.moveEndsAt && performance.now() >= this.moveEndsAt) {
      this.moveEndsAt = 0;
      this.queued = 0;
      this.position = this.moveTarget;
    }
  }
}

export class SimulatedPort {
  constructor(motors) {
    this.motors = motors.map((m) => new SimMotor(m));
    this.opened = false;
    this._ctrl = null;
    this._rx = new Uint8Array(0);
    this._flashTarget = null;
    this.readable = null;
    this.writable = null;
  }

  getInfo() { return { simulated: true }; }

  /** Tell the simulator which release is being written, so it can report the
   *  new version after the upgrade the way real hardware would. */
  expectFirmware(release) { this._flashTarget = release; }

  async open() {
    this.opened = true;
    this.readable = new ReadableStream({
      start: (c) => { this._ctrl = c; },
      cancel: () => { this._ctrl = null; },
    });
    this.writable = new WritableStream({
      write: (chunk) => this._onBytes(chunk),
    });
  }

  async close() {
    this.opened = false;
    try { this._ctrl?.close(); } catch {}
    this._ctrl = null;
  }

  _emit(bytes) { try { this._ctrl?.enqueue(bytes); } catch {} }

  /** Wrap a payload in a response frame the way the firmware does. */
  _respond(payload) {
    const body = concat(Uint8Array.of(RESPONSE_CHAR_CRC32_ENABLED), payload);
    let size = 1 + body.length + 4;
    let head;
    if (size > 127) {
      size += 2;
      head = new Uint8Array(3);
      head[0] = (EXTENDED_SIZE_SENTINEL << 1) | 1;
      new DataView(head.buffer).setUint16(1, size, true);
    } else {
      head = Uint8Array.of((size << 1) | 1);
    }
    let pkt = concat(head, body);
    const tail = new Uint8Array(4);
    new DataView(tail.buffer).setUint32(0, crc32(pkt), true);
    this._emit(concat(pkt, tail));
  }

  _ok(extra) { this._respond(extra ? concat(Uint8Array.of(0), extra) : new Uint8Array(0)); }

  _onBytes(chunk) {
    this._rx = concat(this._rx, chunk);
    for (;;) {
      if (this._rx.length < 1) return;
      const first = this._rx[0];
      if ((first & 1) !== 1) { this._rx = this._rx.subarray(1); continue; }
      let size = first >> 1, headLen = 1;
      if (size === EXTENDED_SIZE_SENTINEL) {
        if (this._rx.length < 3) return;
        size = this._rx[1] | (this._rx[2] << 8);
        headLen = 3;
      }
      if (this._rx.length < size) return;
      const packet = this._rx.slice(0, size);
      this._rx = this._rx.subarray(size);
      this._dispatch(packet, headLen);
    }
  }

  _dispatch(packet, headLen) {
    const dv = new DataView(packet.buffer, packet.byteOffset, packet.length);
    let o = headLen;
    let addr = packet[o++];
    let targetId = null;
    if (addr === EXTENDED_ADDRESSING) { targetId = dv.getBigUint64(o, true); o += 8; }
    const cmd = packet[o++];
    const payload = packet.subarray(o, packet.length - 4);

    const targets = targetId != null
      ? this.motors.filter((m) => m.uniqueId === targetId)
      : addr === ALL_ALIAS
        ? this.motors
        : this.motors.filter((m) => m.alias === addr);
    const broadcast = targetId == null && addr === ALL_ALIAS;

    for (const m of targets) { m.tick(); m.noteTraffic(); }

    // Detect devices is the one broadcast that answers — after a random delay.
    if (cmd === CMD.DETECT_DEVICES) {
      for (const m of this.motors) {
        const delay = 40 + Math.random() * 700;
        setTimeout(() => {
          const p = new Uint8Array(10);
          const d = new DataView(p.buffer);
          d.setUint8(0, 0);
          d.setBigUint64(1, m.uniqueId, true);
          d.setUint8(9, m.alias);
          this._respond(p);
        }, delay);
      }
      return;
    }

    if (cmd === CMD.SYSTEM_RESET) {
      for (const m of targets) {
        // A completed firmware write takes effect on the next boot.
        if (m.flashedPages.size > 0 && this._flashTarget &&
            this._flashTarget.model === m.productCode && this._flashTarget.scc === m.scc) {
          m.firmwareVersion = [...this._flashTarget.version];
        }
        m.reset();
        m.enterBootloader();
      }
      if (!broadcast) this._ok();
      return;
    }

    if (cmd === CMD.FIRMWARE_UPGRADE) {
      const model = new TextDecoder().decode(payload.subarray(0, 8)).trim();
      const scc = payload[8];
      const page = payload[9];
      for (const m of this.motors) {
        if (m.inBootloader && m.productCode === model && m.scc === scc) m.flashedPages.add(page);
      }
      if (!broadcast) this._ok();
      return;
    }

    // Every other command is silent when broadcast.
    if (broadcast) return;

    for (const m of targets) {
      const out = this._exec(m, cmd, payload);
      if (out !== undefined) this._ok(out);
    }
  }

  _exec(m, cmd, payload) {
    const buf = (n, fill) => { const b = new Uint8Array(n); fill(new DataView(b.buffer), b); return b; };

    switch (cmd) {
      case CMD.GET_PRODUCT_INFO: {
        const [maj, min, pat] = `${m.hardwareVersion}.0`.split('.').map(Number);
        return buf(28, (d, b) => { // string8 + u8 + u24 + u32 + u64 + u32
          b.set(new TextEncoder().encode(m.productCode.padEnd(8, ' ')), 0);
          d.setUint8(8, m.scc);
          d.setUint8(9, pat); d.setUint8(10, min); d.setUint8(11, maj);
          d.setUint32(12, m.serialNumber, true);
          d.setBigUint64(16, m.uniqueId, true);
          d.setUint32(24, 0, true);
        });
      }
      case CMD.GET_FIRMWARE_VERSION:
        return buf(5, (d) => {
          const [maj, min, pat, dev] = m.inBootloader ? SimMotor.BOOTLOADER_VERSION : m.firmwareVersion;
          d.setUint8(0, dev); d.setUint8(1, pat); d.setUint8(2, min); d.setUint8(3, maj);
          d.setUint8(4, m.inBootloader ? 1 : 0);
        });
      case CMD.GET_PRODUCT_DESCRIPTION:
        return new TextEncoder().encode(`Gearotons ${m.productCode} servomotor\0`);
      case CMD.GET_PRODUCT_SPECS:
        return buf(8, (d) => { d.setUint32(0, m.updateFrequency, true); d.setUint32(4, m.countsPerRotation, true); });
      case CMD.GET_STATUS:
        return buf(3, (d) => { d.setUint16(0, m.statusFlags, true); d.setUint8(2, m.fatalError); });
      case CMD.GET_SUPPLY_VOLTAGE:
        return buf(2, (d) => d.setUint16(0, m.voltage + Math.round(Math.random() * 3 - 1), true));
      case CMD.GET_TEMPERATURE:
        return buf(2, (d) => d.setInt16(0, m.temperature, true));
      case CMD.GET_POSITION:
        m.tick();
        return buf(8, (d) => d.setBigInt64(0, m.position, true));
      case CMD.GET_N_QUEUED_ITEMS:
        m.tick();
        return buf(1, (d) => d.setUint8(0, m.queued));
      case CMD.SET_DEVICE_ALIAS:
        m.alias = payload[0];
        setTimeout(() => m.reset(), 300); // saves to flash, then reboots
        return null;
      case CMD.ENABLE_MOSFETS: m.mosfets = true; return null;
      case CMD.DISABLE_MOSFETS: m.mosfets = false; return null;
      case CMD.ZERO_POSITION: m.position = 0n; return null;
      case CMD.IDENTIFY: return null;
      case CMD.TRAPEZOID_MOVE: {
        const d = new DataView(payload.buffer, payload.byteOffset, payload.length);
        const counts = d.getInt32(0, true);
        const timesteps = d.getUint32(4, true);
        m.queued = 3;
        m.moveTarget = m.position + BigInt(counts);
        // Simulated motors are 8x faster than real ones so the demo stays snappy.
        m.moveEndsAt = performance.now() + (timesteps / m.updateFrequency) * 1000 / 8;
        return null;
      }
      default:
        return null;
    }
  }
}

/** A representative M17 bus: one needing an update, one already current but with
 *  no alias at all, and one whose alias collides with the first. */
export function demoMotors() {
  const m17 = { productCode: 'M17', scc: 3, hardwareVersion: '1.5' };
  return [
    { ...m17, uniqueId: 0x0A11C0FFEE001234n, alias: 3, firmwareVersion: [0, 15, 3, 0], serialNumber: 240117, voltage: 241 },
    { ...m17, uniqueId: 0x0A11C0FFEE005678n, alias: 255, firmwareVersion: [0, 15, 9, 0], serialNumber: 240118, voltage: 239 },
    { ...m17, uniqueId: 0x0A11C0FFEE009ABCn, alias: 3, firmwareVersion: [0, 15, 2, 0], serialNumber: 240119, voltage: 240 },
  ];
}

export { sleep };
