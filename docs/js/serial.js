// serial.js — Web Serial transport + request/response layer.

import {
  BAUD_RATE, ALL_ALIAS, ResponseFramer, encodePacket, hex,
  TimeoutError, CommunicationError, FatalDeviceError,
} from './protocol.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Owns the SerialPort, pumps the read loop, and turns the byte stream into
 * decoded response frames. One command at a time (the bus is half duplex),
 * serialised through an internal promise chain.
 */
export class Bus extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.framer = new ResponseFramer();
    this.queue = [];          // decoded frames waiting to be consumed
    this.waiters = [];        // {resolve, reject, timer}
    this._chain = Promise.resolve();
    this._readLoop = null;
    this.crcEnabled = true;
    this.logging = true;
    this.errorFrames = [];   // fatal-error codes seen while collecting multi-responses
    this.rxBytes = 0;        // total bytes received, for diagnosing a quiet bus
  }

  get isOpen() { return !!this.port?.readable; }

  log(dir, text, cls) {
    if (!this.logging) return;
    this.dispatchEvent(new CustomEvent('log', { detail: { dir, text, cls, t: performance.now() } }));
  }

  static get supported() { return 'serial' in navigator; }

  async requestPort() {
    const port = await navigator.serial.requestPort();
    return this.open(port);
  }

  /** Reopen a port the user has already granted (survives page reloads). */
  async knownPorts() {
    return Bus.supported ? navigator.serial.getPorts() : [];
  }

  async open(port) {
    if (this.port) await this.close();
    await port.open({
      baudRate: BAUD_RATE,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 64 * 1024, // the 255-byte default drops bytes on 2 kB firmware pages
    });
    this.port = port;
    this.writer = port.writable.getWriter();
    this._pump();
    // Let the adapter settle and discard anything left in its buffers from a
    // previous session before the first command goes out. Without this the first
    // scan of a session can come back short.
    await sleep(250);
    this.flushInput();
    this.dispatchEvent(new CustomEvent('open'));
    return port;
  }

  async close() {
    const port = this.port;
    this.port = null;
    this._failWaiters(new CommunicationError('Port closed'));
    try { await this.reader?.cancel(); } catch {}
    try { await this._readLoop; } catch {}
    try { this.writer?.releaseLock(); } catch {}
    this.reader = null;
    this.writer = null;
    try { await port?.close(); } catch {}
    this.dispatchEvent(new CustomEvent('close'));
  }

  async _pump() {
    this.reader = this.port.readable.getReader();
    this._readLoop = (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length) this._ingest(value);
        }
      } catch (e) {
        this._failWaiters(new CommunicationError(`Read loop stopped: ${e.message}`));
      } finally {
        try { this.reader.releaseLock(); } catch {}
      }
    })();
  }

  _ingest(chunk) {
    this.rxBytes += chunk.length;
    this.log('rx', hex(chunk), 'raw');
    this.framer.push(chunk);
    this._drainFrames();
  }

  _drainFrames() {
    for (;;) {
      const frame = this.framer.next();
      if (!frame) break;
      if (frame.skipped) {
        this.log('rx', `resynced after ${frame.skipped} corrupt byte(s)`, 'err');
      }
      this.log('rx', `frame err=${frame.errorCode} payload=[${hex(frame.payload)}]`, 'frame');
      const w = this.waiters.shift();
      if (w) { clearTimeout(w.timer); w.resolve(frame); }
      else this.queue.push(frame);
    }
  }

  _failWaiters(err) {
    while (this.waiters.length) {
      const w = this.waiters.shift();
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  /** Discard buffered bytes and any frames already decoded. */
  flushInput() {
    this.framer.reset();
    this.queue.length = 0;
  }

  _nextFrame(timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        // A plausible-looking but corrupt length can leave the framer waiting
        // for bytes that will never come. Drop a byte, rescan, and see whether a
        // real frame was hiding behind it before giving up.
        if (this.framer.pending && this.framer.skipByte()) {
          this._drainFrames();
          if (this.queue.length) return resolve(this.queue.shift());
        }
        reject(new TimeoutError('Timed out waiting for a response'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  async writeRaw(bytes) {
    if (!this.writer) throw new CommunicationError('Serial port is not open');
    this.log('tx', hex(bytes), 'raw');
    await this.writer.write(bytes);
  }

  /**
   * Write a packet, splitting long ones.
   *
   * The device drops bytes when a large packet arrives as one continuous burst —
   * verified on hardware: a 2069-byte firmware page written in a single call is
   * never received, while the identical bytes sent as 1000-byte chunks 50 ms
   * apart are received every time. upgrade_firmware.py documents the same
   * workaround ("otherwise there is a strange bug where bytes get dropped").
   * Only firmware pages are anywhere near this size; everything else is one write.
   */
  async writePacket(bytes, { chunkBytes = 1000, chunkDelayMs = 50 } = {}) {
    if (bytes.length <= chunkBytes) return this.writeRaw(bytes);
    for (let i = 0; i < bytes.length; i += chunkBytes) {
      await this.writeRaw(bytes.subarray(i, i + chunkBytes));
      if (i + chunkBytes < bytes.length) await sleep(chunkDelayMs);
    }
  }

  /**
   * Send one command and collect its response(s).
   *
   * @param addr        alias (0..255) or unique ID (BigInt / number > 255)
   * @param commandId
   * @param payload     Uint8Array
   * @param opts.expectResponse  false for fire-and-forget (broadcasts, resets)
   * @param opts.multiple        true to keep reading until a timeout (Detect devices)
   * @param opts.timeout         ms to wait for each frame
   * @param opts.collectWindowMs with `multiple`, collect for this fixed window
   *                             after the write instead of waiting for an idle
   *                             gap. Detect devices replies are spec-bounded to
   *                             950 ms, so a window is both faster and safer than
   *                             an idle timeout on a crowded bus.
   * @returns Uint8Array[] of payloads (error code already stripped)
   */
  send(addr, commandId, payload = new Uint8Array(0), opts = {}) {
    const {
      expectResponse = true, multiple = false, timeout = 1200, flushFirst = false,
      collectWindowMs = 0,
    } = opts;

    const task = async () => {
      if (flushFirst) this.flushInput();
      const packet = encodePacket(addr, commandId, payload, this.crcEnabled);
      this.log('tx', `cmd ${commandId} -> ${typeof addr === 'bigint' ? addr.toString(16).toUpperCase().padStart(16, '0') : addr}`, 'cmd');
      await this.writePacket(packet);

      // Broadcasts (other than Detect devices) never answer.
      if (!expectResponse) return [];

      const out = [];
      const deadline = collectWindowMs ? performance.now() + collectWindowMs : 0;
      for (;;) {
        const wait = deadline ? Math.max(0, deadline - performance.now()) : timeout;
        if (deadline && wait === 0) break;
        let frame;
        try {
          frame = await this._nextFrame(wait);
        } catch (e) {
          if (e instanceof TimeoutError && (multiple || out.length > 0)) break;
          throw e;
        }
        // One motor's fatal error must not abort collection from the others.
        // A latched device answers Detect devices with an error packet instead of
        // its unique ID, so it is undetectable while being perfectly alive. Count
        // these so a scan can say "N devices answered with an error" rather than
        // silently reporting a smaller bus.
        if (frame.errorCode !== 0) {
          if (!multiple) throw new FatalDeviceError(frame.errorCode);
          this.errorFrames.push(frame.errorCode);
          this.log('rx', `device reported fatal error ${frame.errorCode}`, 'err');
          continue;
        }
        out.push(frame.payload);
        if (!multiple) break;
      }
      return out;
    };

    // Serialise: the RS485 bus tolerates exactly one transaction at a time.
    const run = this._chain.then(task, task);
    this._chain = run.catch(() => {});
    return run;
  }
}

export { ALL_ALIAS, TimeoutError, CommunicationError, FatalDeviceError };
