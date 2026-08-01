// protocol.js — byte-level wire protocol for Gearotons servomotors.
// Ported 1:1 from python_programs/servomotor/communication.py (protocol version 20).

export const ALL_ALIAS = 255;                        // broadcast
export const EXTENDED_ADDRESSING = 254;              // next 8 bytes are a unique ID
export const RESPONSE_CHAR_CRC32_ENABLED = 253;
export const RESPONSE_CHAR_CRC32_DISABLED = 252;
export const EXTENDED_SIZE_SENTINEL = 127;
export const BAUD_RATE = 230400;

// Aliases a user may actually assign. 252..254 are reserved and raise
// fatal error 50 (ERROR_BAD_ALIAS) on the device. 255 means "no alias".
export const MIN_ASSIGNABLE_ALIAS = 1;
export const MAX_ASSIGNABLE_ALIAS = 251;

// ---------------------------------------------------------------- CRC32
// Standard CRC-32/ISO-HDLC (zlib.crc32): reflected, poly 0xEDB88320,
// init 0xFFFFFFFF, final xor 0xFFFFFFFF.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- errors
export class TimeoutError extends Error {}
export class CommunicationError extends Error {}
export class FatalDeviceError extends Error {
  constructor(code) {
    super(`Device reported fatal error code ${code}`);
    this.code = code;
  }
}

// ---------------------------------------------------------------- helpers
export const isUniqueId = (addr) => typeof addr === 'bigint' || addr > 255;
const u64le = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
};

export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

/**
 * Build an outgoing packet.
 *
 *   [size byte(s)] [address] [command] [payload...] [crc32 LE (4)]
 *
 * size byte = (packetSize << 1) | 1, where packetSize counts EVERY byte on the
 * wire including the size byte(s) and the CRC32. If packetSize would exceed
 * 127 the size is encoded as 0xFF followed by a little-endian uint16.
 * Address is one byte (alias) or 254 followed by the 8-byte LE unique ID.
 */
export function encodePacket(addr, commandId, payload = new Uint8Array(0), crcEnabled = true) {
  const addressPart = isUniqueId(addr)
    ? concat(Uint8Array.of(EXTENDED_ADDRESSING), u64le(addr))
    : Uint8Array.of(Number(addr));
  const content = concat(addressPart, Uint8Array.of(commandId), payload);

  let packetSize = 1 + content.length + (crcEnabled ? 4 : 0);
  let sizeBytes;
  // encode_first_byte(127) is 0xFF, which is also the extended-size marker, so a
  // short-form packet of exactly 127 bytes is unframeable. communication.py has
  // the same hole (it tests `> 127`); rather than silently emit a corrupt packet
  // or deviate from the reference encoder, refuse. No command this tool sends can
  // land on 127, so this only guards future payload sizes.
  if (packetSize === 127) {
    throw new CommunicationError(
      'Packet length 127 cannot be encoded: the short-form size byte collides with the extended-size marker');
  }
  if (packetSize > 127) {
    packetSize += 2; // three size bytes instead of one
    sizeBytes = new Uint8Array(3);
    sizeBytes[0] = (EXTENDED_SIZE_SENTINEL << 1) | 1; // 0xFF
    new DataView(sizeBytes.buffer).setUint16(1, packetSize, true);
  } else {
    sizeBytes = Uint8Array.of((packetSize << 1) | 1);
  }

  let packet = concat(sizeBytes, content);
  if (crcEnabled) {
    const crcBytes = new Uint8Array(4);
    new DataView(crcBytes.buffer).setUint32(0, crc32(packet), true);
    packet = concat(packet, crcBytes);
  }
  return packet;
}

// Any claimed response length above this is treated as corruption. The largest
// response this tool asks for is Get debug values (~150 bytes); Get product info
// is 35 on the wire. Commands that stream bulk data (Capture hall sensor data,
// Read multipurpose buffer) are not used here — raise this if they ever are.
export const MAX_RESPONSE_BYTES = 512;

const NEED_MORE = Symbol('need-more');
const INVALID = Symbol('invalid');

/**
 * Incremental, self-resynchronising response framer.
 *
 * Critical property: a candidate frame is fully validated (size plausible,
 * response character correct, CRC32 correct) BEFORE any byte is consumed. On a
 * busy bus two motors occasionally transmit close enough together to corrupt a
 * few bytes, and a framer that consumes on the strength of an unvalidated length
 * byte will swallow the good frames behind the bad one. Measured on a 35-motor
 * rack: consume-then-validate decoded as few as 13 of 35 replies from a byte
 * stream that contained all 35. Validate-then-consume, dropping a single byte
 * and rescanning on failure, recovers every intact frame.
 */
export class ResponseFramer {
  constructor() {
    this.buf = new Uint8Array(0);
    this.droppedBytes = 0;   // diagnostics: bytes discarded during resync
    this.badFrames = 0;
  }

  push(chunk) { this.buf = concat(this.buf, chunk); }
  reset() { this.buf = new Uint8Array(0); }
  get pending() { return this.buf.length; }

  /** Force progress when a caller times out with bytes still buffered. */
  skipByte() {
    if (!this.buf.length) return false;
    this.buf = this.buf.subarray(1);
    this.droppedBytes++;
    return true;
  }

  /** Try to decode a frame starting exactly at `off`. Never mutates state. */
  _tryAt(off) {
    const buf = this.buf;
    const avail = buf.length - off;
    if (avail < 1) return NEED_MORE;

    const first = buf[off];
    if ((first & 0x01) !== 0x01) return INVALID;

    let packetSize = first >> 1;
    let headerLen = 1;
    if (packetSize === EXTENDED_SIZE_SENTINEL) {
      if (avail < 3) return NEED_MORE;
      packetSize = buf[off + 1] | (buf[off + 2] << 8);
      headerLen = 3;
    }
    if (packetSize <= headerLen || packetSize > MAX_RESPONSE_BYTES) return INVALID;

    // The response character sits right after the size field; check it before
    // waiting for the rest of the packet so garbage is rejected immediately.
    if (avail > headerLen) {
      const c = buf[off + headerLen];
      if (c !== RESPONSE_CHAR_CRC32_ENABLED && c !== RESPONSE_CHAR_CRC32_DISABLED) return INVALID;
    }
    if (avail < packetSize) return NEED_MORE;

    const raw = buf.slice(off, off + packetSize);
    const body = raw.subarray(headerLen);
    const crcEnabled = body[0] === RESPONSE_CHAR_CRC32_ENABLED;

    let payload;
    if (crcEnabled) {
      if (body.length < 5) return INVALID;
      const received = new DataView(raw.buffer, raw.byteOffset + raw.length - 4, 4).getUint32(0, true);
      if (crc32(raw.subarray(0, raw.length - 4)) !== received) return INVALID;
      payload = body.subarray(1, body.length - 4);
    } else {
      payload = body.subarray(1);
    }

    // Empty payload == plain ACK. Otherwise byte 0 is the error code.
    const errorCode = payload.length === 0 ? 0 : payload[0];
    const data = payload.length === 0 ? payload : payload.subarray(1);
    return { raw, payload: data, crcEnabled, errorCode, size: packetSize };
  }

  /**
   * @returns {null | {raw, payload, crcEnabled, errorCode, skipped}}
   *          null when more bytes are needed.
   */
  next() {
    for (let off = 0; off < this.buf.length; off++) {
      const r = this._tryAt(off);
      if (r === NEED_MORE) {
        // Candidate is plausible but incomplete. Discard anything before it and
        // wait for the rest.
        if (off) { this.buf = this.buf.subarray(off); this.droppedBytes += off; }
        return null;
      }
      if (r === INVALID) continue; // resync: try the next byte position
      this.buf = this.buf.subarray(off + r.size);
      if (off) { this.droppedBytes += off; this.badFrames++; }
      return { ...r, skipped: off };
    }
    // Nothing decodable in the whole buffer.
    this.droppedBytes += this.buf.length;
    this.buf = new Uint8Array(0);
    return null;
  }
}
