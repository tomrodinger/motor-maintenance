// firmware.js — pull firmware releases straight from GitHub, match them to
// detected devices, and flash them over the RS485 bus.
//
// .firmware file layout (verified against the real files in the repo):
//   [0..7]  model code, 8 ASCII bytes, space padded  e.g. "M17     "
//   [8]     firmware compatibility code (u8)         e.g. 3
//   [9..]   raw application image
//
// upgrade_firmware.py then rewrites the image before sending it:
//   pad with zeros to a multiple of 4
//   firmwareSize = (len >> 2) - 1                (replaces the first word,
//                                                 which was the stack pointer)
//   image = u32le(firmwareSize) + image[4..] + u32le(crc32(image[4..]))
// and writes it in 2048-byte pages starting at flash page 5.

import { CMD, u8 } from './commands.js';
import { concat, crc32 } from './protocol.js';
import { sleep } from './serial.js';

export const REPO = { owner: 'tomrodinger', repo: 'servomotor', branch: 'main' };
export const RELEASES_PATH = 'firmware/firmware_releases';

export const FLASH_PAGE_SIZE = 2048;
export const FIRST_FIRMWARE_PAGE = 5;   // pages 0..4 hold factory settings + bootloader
export const LAST_FIRMWARE_PAGE = 30;   // page 31 is non-volatile settings
export const MODEL_CODE_LENGTH = 8;

// Timings from upgrade_firmware.py, empirically determined on real hardware.
export const WAIT_FOR_RESET_MS = 70;      // must land between ~2 ms and ~130 ms
export const DELAY_AFTER_EACH_PAGE_MS = 180; // >= 130 ms or the device's buffer overflows

const CACHE_KEY = 'gearotons.firmware.index.v1';

// ------------------------------------------------------------- filenames
// servomotor_M17_fw0.15.9.0_scc3_hw1.5.firmware
const NAME_RE = /^servomotor_([A-Za-z0-9]+)_fw([0-9]+(?:\.[0-9]+)*)_scc([0-9]+)_hw(.+)\.firmware$/;

export function parseReleaseName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, model, versionStr, scc, hardware] = m;
  const version = versionStr.split('.').map(Number);
  while (version.length < 4) version.push(0);
  return { name, model, version, versionStr, scc: Number(scc), hardware };
}

export const versionLabel = (v) => v.join('.');

export function compareVersion(a, b) {
  for (let i = 0; i < 4; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** "1.5.0" or "1.5" -> "1.5" (major.minor is what the filename encodes). */
export const hwKey = (v) => String(v).split('.').slice(0, 2).join('.');

// ------------------------------------------------------------- fetching
const apiUrl = () =>
  `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/contents/${RELEASES_PATH}?ref=${REPO.branch}`;

export const cdnUrl = (name) =>
  `https://cdn.jsdelivr.net/gh/${REPO.owner}/${REPO.repo}@${REPO.branch}/${RELEASES_PATH}/${name}`;
export const rawUrl = (name) =>
  `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${REPO.branch}/${RELEASES_PATH}/${name}`;

/**
 * List every release in the repo. Uses a conditional request so repeat loads
 * are free against GitHub's 60/hour unauthenticated budget, and falls back to
 * the last good cached listing if the network or the rate limit says no.
 */
export async function fetchReleaseIndex({ force = false } = {}) {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch {}

  const headers = { Accept: 'application/vnd.github+json' };
  if (cached?.etag && !force) headers['If-None-Match'] = cached.etag;

  try {
    const res = await fetch(apiUrl(), { headers, cache: 'no-store' });
    if (res.status === 304 && cached) return { ...cached, source: 'cache (unchanged)' };
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);

    const entries = await res.json();
    const releases = entries
      .filter((e) => e.type === 'file' && e.name.endsWith('.firmware'))
      .map((e) => {
        const parsed = parseReleaseName(e.name);
        return parsed ? { ...parsed, size: e.size, sha: e.sha } : null;
      })
      .filter(Boolean);

    const payload = {
      etag: res.headers.get('etag'),
      fetchedAt: Date.now(),
      rateRemaining: res.headers.get('x-ratelimit-remaining'),
      releases,
    };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(payload)); } catch {}
    return { ...payload, source: 'github' };
  } catch (err) {
    if (cached) return { ...cached, source: `cache (offline: ${err.message})`, stale: true };
    throw err;
  }
}

/** Newest release per (model, scc, hardware) triple. */
export function latestByTarget(releases) {
  const best = new Map();
  for (const r of releases) {
    const key = `${r.model}|${r.scc}|${hwKey(r.hardware)}`;
    const cur = best.get(key);
    if (!cur || compareVersion(r.version, cur.version) > 0) best.set(key, r);
  }
  return best;
}

/**
 * Pick the newest firmware that is safe for this device.
 *
 * The device itself only enforces model code + firmware compatibility code
 * (the bootloader checks both on every page). The hardware revision is NOT
 * checked on the device, so the host must get it right — matching on
 * major.minor of the hardware version is what the filenames encode.
 */
export function pickFirmware(releases, device) {
  const model = (device.productCode || '').trim();
  const scc = device.firmwareCompatibility;
  const hw = hwKey(device.hardwareVersion);

  const exact = releases.filter((r) => r.model === model && r.scc === scc && hwKey(r.hardware) === hw);
  if (exact.length) {
    return { release: exact.sort((a, b) => compareVersion(b.version, a.version))[0], confidence: 'exact' };
  }
  // Same model + compatibility code but no hardware-revision match. The device
  // would accept it, but we must not choose it silently.
  const loose = releases.filter((r) => r.model === model && r.scc === scc);
  if (loose.length) {
    return {
      release: loose.sort((a, b) => compareVersion(b.version, a.version))[0],
      confidence: 'hardware-mismatch',
      reason: `No build for hardware ${hw}; nearest is hw${loose[0].hardware}`,
    };
  }
  return { release: null, confidence: 'none', reason: `No release for model ${model} / scc ${scc}` };
}

// ------------------------------------------------------------- downloading
export async function downloadFirmware(release) {
  const attempts = [cdnUrl(release.name), rawUrl(release.name)];
  let lastErr;
  for (const url of attempts) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Could not download ${release.name}: ${lastErr?.message}`);
}

/** Split a .firmware file into its header and the flashable image. */
export function parseFirmwareFile(bytes) {
  if (bytes.length < MODEL_CODE_LENGTH + 1 + FLASH_PAGE_SIZE - 4) {
    throw new Error('Firmware file is too small to be valid');
  }
  const modelCode = bytes.subarray(0, MODEL_CODE_LENGTH);
  const modelName = new TextDecoder().decode(modelCode).trim();
  const compatibilityCode = bytes[MODEL_CODE_LENGTH];
  const image = bytes.subarray(MODEL_CODE_LENGTH + 1);

  // Pad to a 4-byte boundary, then swap the first word for the size and
  // append the CRC32 — exactly what upgrade_firmware.py does before sending.
  const padded = new Uint8Array(Math.ceil(image.length / 4) * 4);
  padded.set(image);
  const words = (padded.length >> 2) - 1;
  const body = padded.subarray(4);
  const crc = crc32(body);

  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, words, true);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, crc, true);

  const payload = concat(head, body, tail);
  const pages = Math.ceil(payload.length / FLASH_PAGE_SIZE);
  if (FIRST_FIRMWARE_PAGE + pages - 1 > LAST_FIRMWARE_PAGE) {
    throw new Error('Firmware image is too large for this chip');
  }
  return { modelCode, modelName, compatibilityCode, payload, pages, imageCrc: crc };
}

/**
 * Flash one image, either to a single motor or to the whole bus.
 *
 * @param addr 255 to broadcast, or a unique-ID BigInt to target one motor.
 *
 * Broadcast writes every motor whose model code and compatibility code match the
 * page header and are ignored by the rest, so a whole rack updates in one pass.
 * Nothing acknowledges a broadcast page, so pacing is by delay alone.
 *
 * Unicast is acknowledged per page (verified on hardware: 18/18 pages acked, and
 * the other 34 motors on the bus were untouched), so the ACK provides flow
 * control and no inter-page delay is needed.
 *
 * Note: an earlier revision claimed unicast flashing did not work at all. That
 * was wrong — the test predated the chunked-write fix, and the 2069-byte page was
 * being sent as one burst and silently dropped. Any packet this large must go out
 * in <=1000-byte chunks; see Bus.writePacket.
 */
export async function flashFirmware(bus, parsed, { addr = 255, onProgress } = {}) {
  const { modelCode, compatibilityCode, payload, pages } = parsed;
  const broadcast = addr === 255;
  const send = (cmd, body, timeout) =>
    bus.send(addr, cmd, body, { expectResponse: !broadcast, timeout });

  onProgress?.({ phase: 'reset', page: 0, pages, broadcast });
  await send(CMD.SYSTEM_RESET);
  await sleep(WAIT_FOR_RESET_MS); // land inside the bootloader's ~250 ms window

  // Addressing one motor lets us check every assumption instead of hoping. A
  // broadcast can do none of this: nothing answers it.
  if (!broadcast) {
    onProgress?.({ phase: 'confirm-bootloader', page: 0, pages, broadcast });
    let inBootloader = false;
    try {
      // This query doubles as the packet that cancels the application launch, so
      // asking the question is also what keeps the answer true.
      const [p] = await bus.send(addr, CMD.GET_FIRMWARE_VERSION, undefined, { timeout: 1000 });
      inBootloader = p[4] === 1;
    } catch (e) {
      throw new Error(`The motor did not answer after the reset, so the bootloader could not be confirmed (${e.message}). Nothing was written.`);
    }
    if (!inBootloader) {
      throw new Error('The motor restarted into its application instead of staying in the bootloader, so the upgrade was abandoned before any page was written. Retry with the bus otherwise idle.');
    }
  }

  for (let i = 0; i < pages; i++) {
    const pageNumber = FIRST_FIRMWARE_PAGE + i;
    const slice = payload.subarray(i * FLASH_PAGE_SIZE, (i + 1) * FLASH_PAGE_SIZE);
    const page = new Uint8Array(FLASH_PAGE_SIZE); // zero padded
    page.set(slice);

    const body = concat(modelCode, u8(compatibilityCode), u8(pageNumber), page);
    if (broadcast) {
      await send(CMD.FIRMWARE_UPGRADE, body);
      // No acknowledgement to pace against; under ~130 ms the device's receive
      // buffer overflows.
      await sleep(DELAY_AFTER_EACH_PAGE_MS);
    } else {
      // Every unicast page is acknowledged, so a lost page is caught here rather
      // than being discovered at the end as a corrupt image.
      try {
        await bus.send(addr, CMD.FIRMWARE_UPGRADE, body, { expectResponse: true, timeout: 3000 });
      } catch (e) {
        throw new Error(`Page ${i + 1} of ${pages} (flash page ${pageNumber}) was not acknowledged: ${e.message}. ` +
                        'The motor is left in its bootloader, where it is safe and can be written again.');
      }
    }

    onProgress?.({ phase: 'write', page: i + 1, pages, pageNumber, broadcast });
  }

  onProgress?.({ phase: 'finalize', page: pages, pages, broadcast });
  await send(CMD.SYSTEM_RESET);
  await sleep(1500); // let it boot the new image before anyone talks to it
  onProgress?.({ phase: 'done', page: pages, pages, broadcast });
}
