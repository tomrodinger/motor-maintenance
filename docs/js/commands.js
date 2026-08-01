// commands.js — typed command wrappers over the raw bus.
// Command IDs and payload layouts come from servomotor/motor_commands.json.

export const CMD = {
  DISABLE_MOSFETS: 0,
  ENABLE_MOSFETS: 1,
  TRAPEZOID_MOVE: 2,
  START_CALIBRATION: 6,
  GET_N_QUEUED_ITEMS: 11,
  EMERGENCY_STOP: 12,
  ZERO_POSITION: 13,
  GET_STATUS: 16,
  GO_TO_CLOSED_LOOP: 17,
  GET_PRODUCT_SPECS: 18,
  DETECT_DEVICES: 20,
  SET_DEVICE_ALIAS: 21,
  FIRMWARE_UPGRADE: 23,
  GET_PRODUCT_DESCRIPTION: 24,
  GET_FIRMWARE_VERSION: 25,
  SYSTEM_RESET: 27,
  PING: 31,
  GET_POSITION: 34,
  // Developer / production use only. Values 10-13 drive the LEDs and then hang
  // the device until it is power cycled; 14-73 deliberately trigger fatal errors.
  TEST_MODE: 36,
  GET_SUPPLY_VOLTAGE: 38,
  IDENTIFY: 41,
  GET_TEMPERATURE: 42,
  CRC32_CONTROL: 46,
  GET_PRODUCT_INFO: 22,
};

// --------------------------------------------------------------- decoding
export class Reader {
  constructor(bytes) { this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length); this.o = 0; this.bytes = bytes; }
  u8() { return this.dv.getUint8(this.o++); }
  i16() { const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  i32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  i64() { const v = this.dv.getBigInt64(this.o, true); this.o += 8; return v; }
  u64() { const v = this.dv.getBigUint64(this.o, true); this.o += 8; return v; }
  string8() { const s = new TextDecoder().decode(this.bytes.subarray(this.o, this.o + 8)); this.o += 8; return s.trim(); }
  /** u24 version: [patch, minor, major] -> "major.minor.patch" */
  version24() { const p = this.u8(), mi = this.u8(), ma = this.u8(); return `${ma}.${mi}.${p}`; }
  /** u32 version: [development, patch, minor, major] -> "major.minor.patch.development" */
  version32() { const d = this.u8(), p = this.u8(), mi = this.u8(), ma = this.u8(); return [ma, mi, p, d]; }
  get remaining() { return this.bytes.length - this.o; }
}

const bytesOf = (fn, size) => { const b = new Uint8Array(size); fn(new DataView(b.buffer)); return b; };
export const u8 = (v) => Uint8Array.of(v & 0xff);
export const i32le = (v) => bytesOf((dv) => dv.setInt32(0, v, true), 4);
export const u32le = (v) => bytesOf((dv) => dv.setUint32(0, v, true), 4);

// --------------------------------------------------------------- status bits
export const STATUS_BITS = [
  { bit: 0, key: 'inBootloader', label: 'In bootloader' },
  { bit: 1, key: 'mosfetsEnabled', label: 'MOSFETs enabled' },
  { bit: 2, key: 'closedLoop', label: 'Closed loop' },
  { bit: 3, key: 'calibrating', label: 'Calibrating' },
  { bit: 4, key: 'homing', label: 'Homing' },
  { bit: 5, key: 'goingToClosedLoop', label: 'Entering closed loop' },
  { bit: 6, key: 'busy', label: 'Busy' },
];

export function decodeStatus(flags) {
  const s = { raw: flags };
  for (const b of STATUS_BITS) s[b.key] = !!(flags & (1 << b.bit));
  return s;
}

export const versionString = (v) => (Array.isArray(v) ? v.join('.') : String(v));

/** Compare [major, minor, patch, dev] tuples. */
export function compareVersion(a, b) {
  for (let i = 0; i < 4; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// --------------------------------------------------------------- operations
// Each takes the Bus plus an address (alias number or unique-ID BigInt).

export const ops = {
  async systemReset(bus, addr = 255) {
    // Broadcast reset gets no answer; a targeted one does.
    return bus.send(addr, CMD.SYSTEM_RESET, undefined, { expectResponse: addr !== 255 });
  },

  // Every device answers once, after its own pseudo-random 0-950 ms delay, so
  // listen for a fixed window rather than waiting for the bus to go idle.
  async detectDevices(bus, { windowMs = 1150 } = {}) {
    const frames = await bus.send(255, CMD.DETECT_DEVICES, undefined, {
      multiple: true, collectWindowMs: windowMs, flushFirst: true,
    });
    return frames.map((p) => {
      const r = new Reader(p);
      return { uniqueId: r.u64(), alias: r.u8() };
    });
  },

  async getProductInfo(bus, addr) {
    const [p] = await bus.send(addr, CMD.GET_PRODUCT_INFO);
    const r = new Reader(p);
    return {
      productCode: r.string8(),
      firmwareCompatibility: r.u8(),
      hardwareVersion: r.version24(),
      serialNumber: r.u32(),
      uniqueId: r.u64(),
      reserved: r.u32(),
    };
  },

  async getFirmwareVersion(bus, addr) {
    const [p] = await bus.send(addr, CMD.GET_FIRMWARE_VERSION);
    const r = new Reader(p);
    return { version: r.version32(), inBootloader: r.u8() === 1 };
  },

  async getProductDescription(bus, addr) {
    const [p] = await bus.send(addr, CMD.GET_PRODUCT_DESCRIPTION);
    const end = p.indexOf(0);
    return new TextDecoder().decode(p.subarray(0, end < 0 ? p.length : end));
  },

  async getStatus(bus, addr) {
    const [p] = await bus.send(addr, CMD.GET_STATUS);
    const r = new Reader(p);
    const flags = r.u16();
    return { ...decodeStatus(flags), fatalErrorCode: r.u8() };
  },

  async getProductSpecs(bus, addr) {
    const [p] = await bus.send(addr, CMD.GET_PRODUCT_SPECS);
    const r = new Reader(p);
    return { updateFrequency: r.u32(), countsPerRotation: r.u32() };
  },

  async getSupplyVoltage(bus, addr) {
    const [p] = await bus.send(addr, CMD.GET_SUPPLY_VOLTAGE);
    return new Reader(p).u16() / 10; // decivolts -> volts
  },

  async getTemperature(bus, addr) {
    const [p] = await bus.send(addr, CMD.GET_TEMPERATURE);
    const t = new Reader(p).i16();
    return t === 0 ? null : t; // 0 is the firmware's out-of-range sentinel
  },

  async getPosition(bus, addr) {
    const [p] = await bus.send(addr, CMD.GET_POSITION);
    return new Reader(p).i64();
  },

  async getQueuedItems(bus, addr) {
    const [p] = await bus.send(addr, CMD.GET_N_QUEUED_ITEMS);
    return new Reader(p).u8();
  },

  async setDeviceAlias(bus, addr, alias) {
    return bus.send(addr, CMD.SET_DEVICE_ALIAS, u8(alias));
  },

  async identify(bus, addr) { return bus.send(addr, CMD.IDENTIFY); },
  async enableMosfets(bus, addr) { return bus.send(addr, CMD.ENABLE_MOSFETS); },
  async disableMosfets(bus, addr) { return bus.send(addr, CMD.DISABLE_MOSFETS); },
  async zeroPosition(bus, addr) { return bus.send(addr, CMD.ZERO_POSITION); },

  async trapezoidMove(bus, addr, counts, timesteps) {
    const payload = new Uint8Array(8);
    payload.set(i32le(counts), 0);
    payload.set(u32le(timesteps), 4);
    return bus.send(addr, CMD.TRAPEZOID_MOVE, payload);
  },
};
