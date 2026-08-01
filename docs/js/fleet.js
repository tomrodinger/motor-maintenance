// fleet.js — high level orchestration: discover the bus, enrich each motor,
// assign aliases, run the alive test, and drive firmware upgrades.
//
// Everything here addresses motors by UNIQUE ID (extended addressing) rather
// than by alias. That is the key robustness decision: duplicate aliases and
// unassigned aliases stop being a problem, so a fresh motor straight out of
// the box is fully manageable before it has any alias at all.

import { CMD, ops, compareVersion, u8 } from './commands.js';
import { sleep } from './serial.js';
import { MIN_ASSIGNABLE_ALIAS, MAX_ASSIGNABLE_ALIAS, TimeoutError } from './protocol.js';
import * as fw from './firmware.js';

// device_detection.py waits 1.5 s after a reset. That is far more conservative
// than the hardware needs: the bootloader window is ~250 ms (measured — held at
// 240 ms, launched the application by 300 ms), after which the device is running
// normally. Nothing may be sent inside that window or the device stays in the
// bootloader, so 300 ms is the smallest safe wait.
export const RESET_SETTLE_MS = 1500;   // still used where the Python tools' margin is kept
export const RESET_TO_APP_MS = 300;    // measured minimum for a device to be back in the app
// A device ignores everything for ~1 s after a Detect devices command.
export const DETECT_QUIET_MS = 1100;

export const idHex = (id) => id.toString(16).toUpperCase().padStart(16, '0');

const numRange = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
/** Skip forward to `start`, given either as a character or a decimal string. */
const dropUntil = (values, start) => {
  if (start == null || start === '') return values;
  const code = String(start).length === 1 ? String(start).charCodeAt(0) : Number(start);
  const i = values.indexOf(code);
  return i < 0 ? [] : values.slice(i);
};
/** Aliases 33..126 are printable; show those as characters, the rest as numbers. */
export const aliasText = (a) =>
  a === 255 ? 'none' : (a >= 33 && a <= 126 ? `${a} “${String.fromCharCode(a)}”` : String(a));

export class Fleet extends EventTarget {
  constructor(bus) {
    super();
    this.bus = bus;
    this.motors = new Map(); // idHex -> motor record
    this.releases = [];
    this.releaseMeta = null;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /** Stable display order — detection order is randomised by the protocol's
   *  reply delays, so sort deterministically instead. */
  get list() {
    return [...this.motors.values()].sort((a, b) => {
      if (a.present !== b.present) return a.present ? -1 : 1;
      const am = a.info?.productCode || '', bm = b.info?.productCode || '';
      if (am !== bm) return am.localeCompare(bm);
      if (a.alias !== b.alias) return a.alias - b.alias;
      return a.uniqueId < b.uniqueId ? -1 : 1;
    });
  }

  // ------------------------------------------------------------- firmware index
  async loadReleaseIndex(opts) {
    const idx = await fw.fetchReleaseIndex(opts);
    this.releases = idx.releases;
    this.releaseMeta = idx;
    for (const m of this.motors.values()) this._matchFirmware(m);
    this.emit('releases', idx);
    return idx;
  }

  _matchFirmware(motor) {
    if (!motor.info || !this.releases.length) return;
    const pick = fw.pickFirmware(this.releases, motor.info);
    motor.firmware = pick;
    motor.updateAvailable = !!(
      pick.release && motor.firmwareVersion &&
      compareVersion(pick.release.version, motor.firmwareVersion) > 0
    );
  }

  // ------------------------------------------------------------- discovery
  /**
   * Full bus scan: reset the bus, wait for the devices to leave their bootloader
   * window, then run detection passes and merge the results by unique ID.
   *
   * Pass count is adaptive rather than fixed. On a crowded bus two motors
   * occasionally transmit simultaneously and neither reply survives — measured on
   * a 35-motor rack, a single pass yields 31-35 devices. So keep scanning until
   * `dryPassesToStop` consecutive passes turn up nothing new, which converges in
   * two passes on a small bus and keeps working on a large one.
   */
  async scan({ minPasses = 2, maxPasses = 8, dryPassesToStop = 2, enrich = true, signal } = {}) {
    // A scan's results are only valid for the bus it ran on. Aborting alone is not
    // enough: cancellation is only observed at these checkpoints, so a scan that
    // has already passed its last one would still merge its findings into a fleet
    // that has since been pointed at a different port.
    const startPort = this.bus.port;
    const check = () => {
      if (signal?.aborted) throw new Error('Scan cancelled');
      if (this.bus.port !== startPort) throw new Error('Serial port changed during the scan');
    };
    const found = new Map();
    let step = 0;
    // Steps are estimated: two per pass plus the final reset. The estimate is
    // revised upward if the bus keeps yielding new motors.
    let totalSteps = minPasses * 2 + 1;
    const tick = (label) => this.emit('scan-progress', { step: ++step, totalSteps, label, found: found.size });

    let dry = 0;
    let pass = 0;
    let bestPassYield = 0;
    // Converged means two things, not one: no pass is turning up anything new,
    // AND at least one single pass saw the whole set. Measured on a 35-motor rack
    // a pass returns 30-35, so "nothing new twice" alone can stop while motors are
    // still missing — and then reports the short count as if it were certain.
    const converged = () => dry >= dryPassesToStop && bestPassYield >= found.size;
    while (pass < maxPasses && (pass < minPasses || !converged())) {
      pass++;
      if (step + 3 > totalSteps) totalSteps = step + 3; // keep the bar honest
      check();
      tick(`Resetting the bus (pass ${pass})`);
      await ops.systemReset(this.bus, 255);
      await sleep(RESET_SETTLE_MS);

      check();
      tick(found.size ? `Listening for motors — ${found.size} found so far` : 'Listening for motors');
      this.bus.flushInput();
      const started = performance.now();
      let devices = [];
      try {
        devices = await ops.detectDevices(this.bus);
      } catch (e) {
        if (!(e instanceof TimeoutError)) this.emit('warning', { message: `Detection pass failed: ${e.message}` });
      }
      let fresh = 0;
      for (const d of devices) {
        const key = idHex(d.uniqueId);
        const prev = found.get(key);
        if (!prev) fresh++;
        else if (prev.alias !== d.alias) {
          this.emit('warning', { message: `Motor ${key} reported two different aliases (${prev.alias} and ${d.alias})` });
        }
        found.set(key, d);
      }
      dry = fresh ? 0 : dry + 1;
      bestPassYield = Math.max(bestPassYield, devices.length);
      const elapsed = performance.now() - started;
      if (elapsed < DETECT_QUIET_MS) await sleep(DETECT_QUIET_MS - elapsed);
    }
    if (pass >= maxPasses && !converged()) {
      this.emit('warning', {
        message: bestPassYield < found.size
          ? `The bus is marginal: ${found.size} motors were found in total, but no single pass saw more than ` +
            `${bestPassYield}. Some may still be missing — check wiring and termination, then scan again.`
          : `The bus was still turning up new motors after ${maxPasses} passes — scan again to be sure all of them are listed.`,
      });
    }

    check();
    totalSteps = step + 1;
    tick('Returning motors to normal operation');
    await ops.systemReset(this.bus, 255);
    await sleep(RESET_SETTLE_MS);
    check();                 // last gate before anything is written to the fleet
    this.bus.flushInput();

    // Merge into the live map, keeping records for motors we already know.
    // A motor we have seen before but not this time is reported as absent rather
    // than quietly forgotten — on a degraded bus every pass can come back short,
    // and no detection strategy can tell "not present" from "not reachable".
    const previouslyKnown = [...this.motors.values()].filter((m) => m.present).length;
    if (previouslyKnown && found.size < previouslyKnown) {
      this.emit('warning', {
        message: `${previouslyKnown - found.size} motor(s) seen in the last scan did not answer this time. ` +
                 `They are shown as absent — check power and wiring, or scan again.`,
      });
    }

    const seen = new Set();
    for (const [key, d] of found) {
      seen.add(key);
      const existing = this.motors.get(key);
      const motor = existing || { key, uniqueId: d.uniqueId, busy: false, log: [] };
      motor.alias = d.alias;
      motor.present = true;
      this.motors.set(key, motor);
    }
    for (const [key, m] of this.motors) if (!seen.has(key)) m.present = false;

    this._flagDuplicateAliases();
    this.emit('motors', this.list);

    if (enrich) {
      for (const motor of this.list) {
        if (!motor.present) continue;
        check();
        await this.refresh(motor);
      }
    }
    this.emit('scan-complete', this.list);
    return this.list;
  }

  _flagDuplicateAliases() {
    const counts = new Map();
    for (const m of this.motors.values()) {
      if (!m.present || m.alias === 255) continue;
      counts.set(m.alias, (counts.get(m.alias) || 0) + 1);
    }
    for (const m of this.motors.values()) m.duplicateAlias = m.present && counts.get(m.alias) > 1;
  }

  /** Read everything we display for one motor. Addressed by unique ID. */
  async refresh(motor) {
    const addr = motor.uniqueId;
    motor.error = null;
    this.emit('motor-busy', { motor, busy: true, label: 'Reading device information' });
    try {
      motor.info = await ops.getProductInfo(this.bus, addr);
      const fwv = await ops.getFirmwareVersion(this.bus, addr);
      motor.firmwareVersion = fwv.version;
      motor.inBootloader = fwv.inBootloader;
      motor.specs = await ops.getProductSpecs(this.bus, addr);
      motor.status = await ops.getStatus(this.bus, addr);
      motor.voltage = await ops.getSupplyVoltage(this.bus, addr);
      motor.temperature = await ops.getTemperature(this.bus, addr);
      try { motor.description = await ops.getProductDescription(this.bus, addr); } catch { /* older firmware */ }
      this._matchFirmware(motor);
    } catch (e) {
      motor.error = e.message;
    } finally {
      this.emit('motor-busy', { motor, busy: false });
      this.emit('motor-updated', motor);
    }
    return motor;
  }

  // ------------------------------------------------------------- actions
  async identify(motor) {
    return this._act(motor, 'Identifying', async () => {
      await ops.identify(this.bus, motor.uniqueId);
    });
  }

  /**
   * @param opts.onAck called the moment the motor acknowledges the reset, before
   *        the restart delay — that is when the command is genuinely confirmed,
   *        and the operator should not have to wait out the settle to see it.
   */
  async reset(motor, { onAck } = {}) {
    return this._act(motor, 'Resetting', async (report) => {
      await ops.systemReset(this.bus, motor.uniqueId);
      onAck?.();
      // Nothing may be sent to this motor now: any addressed packet arriving
      // inside the bootloader window pins it there instead of letting the
      // application start. The caller blocks input for the duration.
      report('Restarting');
      await sleep(RESET_TO_APP_MS);
      await this.refresh(motor);
    });
  }

  // ------------------------------------------------------------- broadcast
  /**
   * Send a command to every device at once (alias 255). Nothing answers a
   * broadcast, so success here means "sent", not "acknowledged" — the caller
   * must not wait for or expect a reply.
   */
  async broadcast(kind, opts = {}) {
    switch (kind) {
      case 'identify':
        return this.bus.send(255, CMD.IDENTIFY, undefined, { expectResponse: false });
      case 'reset':
        await ops.systemReset(this.bus, 255);
        await sleep(RESET_TO_APP_MS);
        return;
      case 'alias': {
        const alias = opts.alias;
        if (alias !== 255 && (alias < MIN_ASSIGNABLE_ALIAS || alias > MAX_ASSIGNABLE_ALIAS)) {
          throw new Error(`Alias must be ${MIN_ASSIGNABLE_ALIAS}-${MAX_ASSIGNABLE_ALIAS}, or 255 to clear it`);
        }
        await this.bus.send(255, CMD.SET_DEVICE_ALIAS, u8(alias), { expectResponse: false });
        await sleep(800); // every device saves to flash and reboots
        for (const m of this.list) if (m.present) m.alias = alias;
        this._flagDuplicateAliases();
        this.emit('motors', this.list);
        return;
      }
      case 'alive': {
        // Every motor spins at once. The caller is responsible for warning about
        // the current draw; specs come from any one motor since a broadcast
        // Get product specs returns nothing.
        const ref = this.list.find((m) => m.present && m.specs);
        if (!ref) throw new Error('Scan first so the motion units are known');
        const { rotations = 1, seconds = 2 } = opts;
        const counts = Math.round(ref.specs.countsPerRotation * rotations);
        const timesteps = Math.round(ref.specs.updateFrequency * seconds);
        await ops.systemReset(this.bus, 255);
        await sleep(RESET_TO_APP_MS);
        await this.bus.send(255, CMD.ENABLE_MOSFETS, undefined, { expectResponse: false });
        await sleep(300);
        await this.bus.send(255, CMD.ZERO_POSITION, undefined, { expectResponse: false });
        await ops.trapezoidMove(this.bus, 255, counts, timesteps).catch(() => {});
        await sleep(seconds * 1000 + 500);
        await this.bus.send(255, CMD.DISABLE_MOSFETS, undefined, { expectResponse: false });
        return;
      }
      default:
        throw new Error(`Unknown broadcast command: ${kind}`);
    }
  }

  /**
   * Alive test: energise, turn exactly one revolution, verify the shaft got
   * there, de-energise. Mirrors command_examples/example_trapezoid_move.py.
   */
  async aliveTest(motor, { rotations = 1, seconds = 2 } = {}) {
    return this._act(motor, 'Running alive test', async (report) => {
      const addr = motor.uniqueId;
      const specs = motor.specs || (motor.specs = await ops.getProductSpecs(this.bus, addr));
      const counts = Math.round(specs.countsPerRotation * rotations);
      const timesteps = Math.round(specs.updateFrequency * seconds);

      report('Resetting the motor');
      await ops.systemReset(this.bus, addr);
      await sleep(RESET_SETTLE_MS);

      report('Enabling MOSFETs');
      await ops.enableMosfets(this.bus, addr);
      await sleep(300); // let the commutation snap settle before zeroing

      report('Zeroing position');
      await ops.zeroPosition(this.bus, addr);

      report(`Turning ${rotations} revolution${rotations === 1 ? '' : 's'}`);
      await ops.trapezoidMove(this.bus, addr, counts, timesteps);

      const deadline = performance.now() + seconds * 1000 + 4000;
      for (;;) {
        await sleep(80);
        if ((await ops.getQueuedItems(this.bus, addr)) === 0) break;
        if (performance.now() > deadline) throw new Error('The move did not finish in time');
      }
      await sleep(200); // mechanical settling

      const position = await ops.getPosition(this.bus, addr);
      // Read status while the move is still fresh — a fatal error from the move
      // is what we are testing for.
      const status = await ops.getStatus(this.bus, addr);

      report('Disabling MOSFETs');
      await ops.disableMosfets(this.bus, addr);

      const achieved = Number(position) / specs.countsPerRotation;
      const errorPct = Math.abs(achieved - rotations) * 100;
      const result = {
        achieved, expected: rotations, errorPct,
        fatalErrorCode: status.fatalErrorCode,
        passed: status.fatalErrorCode === 0 && errorPct < 2,
      };
      motor.aliveTest = result;
      motor.status = await ops.getStatus(this.bus, addr); // post-disable, for display
      return result;
    });
  }

  /**
   * Assign an alias and wait for the device to save it and reboot.
   * The device answers first, then writes flash and resets itself, so the bus
   * must stay quiet for a moment afterwards.
   */
  async setAlias(motor, alias) {
    if (alias !== 255 && (alias < MIN_ASSIGNABLE_ALIAS || alias > MAX_ASSIGNABLE_ALIAS)) {
      throw new Error(`Alias must be ${MIN_ASSIGNABLE_ALIAS}-${MAX_ASSIGNABLE_ALIAS}, or 255 to clear it`);
    }
    return this._act(motor, 'Setting alias', async (report) => {
      await ops.setDeviceAlias(this.bus, motor.uniqueId, alias);
      report('Saving to flash and rebooting');
      await sleep(800); // >= 0.5 s of bus silence; do not poll during the reboot
      motor.alias = alias;
      this._flagDuplicateAliases();
      await this.refresh(motor);
    });
  }

  /** Give every motor a unique alias in range, changing as few as possible. */
  /**
   * Alias numbering schemes. Every candidate must land in 0..251 — 252, 253 and
   * 254 are reserved and raise fatal error 50, and 255 means "no alias".
   */
  static ALIAS_SCHEMES = {
    numeric: {
      label: 'Numbers from a starting value',
      hint: 'Plain decimal: 1, 2, 3 …',
      defaultStart: '1',
      values: (start) => {
        const n = Number(start);
        if (!Number.isInteger(n) || n < 0 || n > MAX_ASSIGNABLE_ALIAS) return [];
        return numRange(n, MAX_ASSIGNABLE_ALIAS);
      },
    },
    upper: { label: 'Capital letters', hint: 'A–Z, 26 available', defaultStart: 'A',
      values: (s) => dropUntil(numRange(65, 90), s) },
    lower: { label: 'Small letters', hint: 'a–z, 26 available', defaultStart: 'a',
      values: (s) => dropUntil(numRange(97, 122), s) },
    letters: { label: 'Capital and small letters', hint: 'A–Z then a–z, 52 available', defaultStart: 'A',
      values: (s) => dropUntil([...numRange(65, 90), ...numRange(97, 122)], s) },
    alphanumeric: { label: 'Alphanumeric', hint: '0–9, A–Z, a–z, 62 available', defaultStart: '0',
      values: (s) => dropUntil([...numRange(48, 57), ...numRange(65, 90), ...numRange(97, 122)], s) },
    ascii: { label: 'Readable ASCII characters', hint: '! through ~, 94 available', defaultStart: '!',
      values: (s) => dropUntil(numRange(33, 126), s) },
  };

  /**
   * Give every motor a unique alias.
   *
   * @param opts.scheme key of ALIAS_SCHEMES; omit to only repair conflicts
   * @param opts.start  first value of the chosen scheme
   *
   * Without a scheme this is conservative — a motor already holding a valid,
   * unique alias keeps it, and only conflicts and unassigned motors move. With a
   * scheme, every motor is renumbered in the order shown on screen.
   */
  planAliases({ scheme = null, start = null } = {}) {
    const motors = this.list.filter((m) => m.present);

    if (scheme) {
      const def = Fleet.ALIAS_SCHEMES[scheme];
      if (!def) throw new Error(`Unknown alias scheme: ${scheme}`);
      const values = def.values(start ?? def.defaultStart);
      if (!values.length) throw new Error('That starting value is not valid for this scheme');
      if (values.length < motors.length) {
        throw new Error(`This scheme gives ${values.length} aliases from that start, but ${motors.length} motors need one`);
      }
      return motors.map((m, i) => ({
        motor: m, from: m.alias, to: values[i], change: values[i] !== m.alias,
      }));
    }

    const taken = new Set();
    const plan = [];
    for (const m of motors) {
      const ok = m.alias >= MIN_ASSIGNABLE_ALIAS && m.alias <= MAX_ASSIGNABLE_ALIAS && !taken.has(m.alias);
      if (ok) { taken.add(m.alias); plan.push({ motor: m, from: m.alias, to: m.alias, change: false }); }
      else plan.push({ motor: m, from: m.alias, to: null, change: true });
    }
    let next = MIN_ASSIGNABLE_ALIAS;
    for (const p of plan) {
      if (!p.change) continue;
      while (taken.has(next)) next++;
      if (next > MAX_ASSIGNABLE_ALIAS) throw new Error('Ran out of aliases');
      taken.add(next);
      p.to = next;
    }
    return plan;
  }

  async applyAliasPlan(plan, { onStep } = {}) {
    const changes = plan.filter((p) => p.change);
    for (let i = 0; i < changes.length; i++) {
      const p = changes[i];
      onStep?.({ index: i, total: changes.length, plan: p });
      await this.setAlias(p.motor, p.to);
    }
    return changes.length;
  }

  // ------------------------------------------------------------- firmware
  /**
   * Upgrade a set of motors. Motors that need the same image are grouped and
   * flashed together with a single broadcast pass — the bootloader filters on
   * model code + compatibility code, so non-matching motors ignore the traffic.
   */
  /**
   * Every release that this motor's bootloader would accept: same model code and
   * same firmware compatibility code, which are the only two things the device
   * checks. Newest first. Hardware revision is annotated but not filtered on,
   * because the device does not enforce it and older builds are legitimate
   * downgrade targets.
   */
  compatibleReleases(motor) {
    if (!motor.info) return [];
    const model = (motor.info.productCode || '').trim();
    const hw = fw.hwKey(motor.info.hardwareVersion);
    const list = this.releases
      .filter((r) => r.model === model && r.scc === motor.info.firmwareCompatibility)
      .map((r) => ({
        ...r,
        hardwareMatches: fw.hwKey(r.hardware) === hw,
        isCurrent: false,
        isNewer: motor.firmwareVersion
          ? compareVersion(r.version, motor.firmwareVersion) > 0 : false,
      }))
      // Builds for this motor's own hardware revision first, then newest first.
      .sort((a, b) => (b.hardwareMatches - a.hardwareMatches) || compareVersion(b.version, a.version));

    // The same version can exist for several hardware revisions, so mark only the
    // most relevant one as installed rather than tagging every same-numbered build.
    if (motor.firmwareVersion) {
      const match = list.find((r) => compareVersion(r.version, motor.firmwareVersion) === 0);
      if (match) match.isCurrent = true;
    }
    return list;
  }

  /** @param opts.release flash this exact build instead of the newest match. */
  async upgrade(motors, { onProgress, release: override } = {}) {
    const groups = new Map();
    for (const m of motors) {
      const rel = override || m.firmware?.release;
      if (!rel) continue;
      if (!groups.has(rel.name)) groups.set(rel.name, { release: rel, motors: [] });
      groups.get(rel.name).motors.push(m);
    }
    if (!groups.size) throw new Error('No matching firmware for the selected motors');

    const results = [];
    // Remembered so a failure can be told apart: still on the old version means
    // the image never took, anything else means it took and went wrong.
    const versionBefore = new Map(
      motors.map((m) => [m.key, m.firmwareVersion?.join('.') ?? null]));
    let groupIndex = 0;
    for (const group of groups.values()) {
      const { release } = group;
      let members = group.motors;
      groupIndex++;
      const label = `${release.model} ${release.versionStr} (hw ${release.hardware})`;
      onProgress?.({ stage: 'download', label, groupIndex, groups: groups.size, motors: members });
      const bytes = await fw.downloadFirmware(release);
      const parsed = fw.parseFirmwareFile(bytes);
      this.bus.port?.expectFirmware?.(release); // demo mode only; real ports ignore this

      // Refuse to send an image whose header does not match the target.
      for (const m of members) {
        if (parsed.modelName !== (m.info.productCode || '').trim() ||
            parsed.compatibilityCode !== m.info.firmwareCompatibility) {
          throw new Error(
            `Safety check failed: ${release.name} is for ${parsed.modelName}/scc${parsed.compatibilityCode} ` +
            `but motor ${idHex(m.uniqueId)} is ${m.info.productCode}/scc${m.info.firmwareCompatibility}`);
        }
      }

      // A broadcast page is accepted by every motor whose model and
      // compatibility code match, so it is only safe when the selection already
      // covers all of them. For a subset, flash each one by unique ID — verified
      // on hardware to work and to leave the rest of the bus untouched.
      const matchingOnBus = this.list.filter((m) =>
        m.present && m.info &&
        (m.info.productCode || '').trim() === parsed.modelName &&
        m.info.firmwareCompatibility === parsed.compatibilityCode);
      const chosen = new Set(members.map((m) => m.key));
      const useBroadcast = matchingOnBus.length > 1 && matchingOnBus.every((m) => chosen.has(m.key));

      for (const m of members) { m.busy = true; m.busyLabel = 'Upgrading firmware'; }
      this.emit('motors', this.list);

      try {
        if (useBroadcast) {
          await fw.flashFirmware(this.bus, parsed, {
            addr: 255,
            onProgress: (p) => onProgress?.({
              stage: 'flash', label, groupIndex, groups: groups.size, motors: members, ...p,
            }),
          });
        } else {
          for (let i = 0; i < members.length; i++) {
            const m = members[i];
            await fw.flashFirmware(this.bus, parsed, {
              addr: m.uniqueId,
              onProgress: (p) => onProgress?.({
                stage: 'flash', groupIndex, groups: groups.size, motors: [m],
                label: members.length > 1 ? `${label} — motor ${i + 1} of ${members.length}` : label,
                ...p,
              }),
            });
          }
        }
      } finally {
        for (const m of members) { m.busy = false; m.busyLabel = null; }
      }

      onProgress?.({ stage: 'verify', label, groupIndex, groups: groups.size, motors: members });
      for (const m of members) {
        const before = versionBefore.get(m.key);
        // Clear the cached version first: refresh() leaves the previous value in
        // place when it throws, which would otherwise report a silent motor as
        // still running its old firmware instead of as unreadable.
        m.firmwareVersion = null;
        m.inBootloader = false;
        await this.refresh(m);
        const actual = m.firmwareVersion?.join('.') ?? null;
        results.push({
          motor: m,
          release,
          before,
          expected: release.versionStr,
          actual,
          responded: actual != null,
          inBootloader: !!m.inBootloader,
          error: m.error || null,
          ok: actual === release.version.join('.') && !m.inBootloader,
        });
      }
    }
    this.emit('motors', this.list);
    return results;
  }

  // ------------------------------------------------------------- internals
  async _act(motor, label, fn) {
    motor.busy = true;
    motor.busyLabel = label;
    motor.error = null;
    this.emit('motor-updated', motor);
    const report = (text) => { motor.busyLabel = text; this.emit('motor-updated', motor); };
    try {
      return await fn(report);
    } catch (e) {
      motor.error = e.message;
      throw e;
    } finally {
      motor.busy = false;
      motor.busyLabel = null;
      this.emit('motor-updated', motor);
    }
  }
}

export { CMD };
