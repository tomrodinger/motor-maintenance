// app.js — wiring and rendering.

import { Bus } from './serial.js';
import { Fleet, idHex, aliasText } from './fleet.js';
import { STATUS_BITS } from './commands.js';
import { SimulatedPort, demoMotors } from './simulator.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const bus = new Bus();
const fleet = new Fleet(bus);
// Handy from devtools when debugging a bus problem in the field.
window.gearotons = { bus, fleet, diagnoseUpgrade, reportUpgradeFailures, doFixAliases, chooseAliasScheme };
let errorCodes = null;
let scanning = false;
let view = localStorage.getItem('gearotons.view') === 'table' ? 'table' : 'cards';
let sort = { key: 'alias', dir: 1 };
let scanAbort = null;
let knownPortCount = 0;   // how many adapters this page may open
// Models currently sold. Others exist in the firmware repository as prototypes
// and still work if one is found on the bus, but are not advertised in the UI.
const SHIPPING_MODELS = new Set(['M17']);
// Resolves once start-up has finished deciding whether to reopen a remembered
// port. Connecting or entering demo mode before that races the auto-reconnect
// and can leave the fleet holding motors from one bus while the port is another.
// Created synchronously at module scope: assigning it inside init() left it null
// for anyone who clicked during load, which is exactly when the race happens.
let bootDone;
const booting = new Promise((resolve) => { bootDone = resolve; });

// ─────────────────────────────────────────────────────── boot
init();

async function init() {
  try { await initInner(); } finally { bootDone(); }
}

async function initInner() {
  if (!Bus.supported) {
    $('connectBtn').disabled = true;
    $('connectHint').textContent =
      'This browser does not support the Web Serial API. Use Chrome, Edge or Opera on desktop.';
    $('connectHint').style.color = 'var(--warn)';
  }

  fetch('data/error_codes.json')
    .then((r) => r.json())
    .then((d) => { errorCodes = new Map(d.errors.map((e) => [e.code, e])); })
    .catch(() => {});

  // Pull the firmware index immediately — it does not need a serial port.
  loadReleases();

  wireEvents();
  installInputLock();

  // Reopen a port the operator already granted, so a reload picks up where it
  // left off — but only when the choice is unambiguous.
  //
  // Several RS485 adapters of the same make are indistinguishable here: getInfo()
  // returns the same USB vendor and product for each, so grabbing "the first one
  // that opens" can silently land on an adapter with nothing attached. That looks
  // exactly like a broken tool: connected, but no motors, ever. When more than one
  // is paired, prefer the one that last had motors on it and otherwise ask.
  let reopened = false;
  try {
    if (Bus.supported) {
      const ports = await bus.knownPorts();
      knownPortCount = ports.length;
      // Beware Number(null) === 0: an absent entry must not look like index 0,
      // or the "ask which adapter" path never runs.
      const saved = localStorage.getItem('gearotons.portIndex');
      const remembered = saved === null ? -1 : Number(saved);
      const candidate = ports.length === 1 ? ports[0]
        : (Number.isInteger(remembered) && remembered >= 0 ? ports[remembered] : null);

      if (candidate) {
        try { await bus.open(candidate); reopened = true; } catch (e) { connectError(explainOpenFailure(e)); }
      } else if (ports.length > 1) {
        connectError(`<div><b>${ports.length} adapters are paired with this page.</b>
          They report identical USB identifiers, so this tool cannot tell which one your motors are on.
          Press Connect and pick it by name — Chrome lists the device path.</div>`);
      }
    }
  } catch (e) {
    connectError(explainOpenFailure(e));
  }
  // Only scan if nothing else grabbed the port while we were reopening it.
  if (reopened && bus.isOpen && !scanning) doScan();
}

async function loadReleases(force = false) {
  const text = $('fwIndexText');
  const dot = $('fwIndexPill').querySelector('.dot');
  try {
    const idx = await fleet.loadReleaseIndex({ force });
    // The repository also carries builds for prototypes that were never released
    // as products, so count only the shipping model. Everything else stays in the
    // index and is still offered to any motor that reports that model, but it is
    // not advertised here.
    const shipping = idx.releases.filter((r) => SHIPPING_MODELS.has(r.model));
    text.textContent = `${shipping.length} firmware releases · ${[...SHIPPING_MODELS].join(', ')}`;
    $('fwIndexPill').title =
      `Source: ${idx.source}\nFetched: ${new Date(idx.fetchedAt).toLocaleString()}` +
      (idx.rateRemaining ? `\nGitHub requests left this hour: ${idx.rateRemaining}` : '');
    dot.className = idx.stale ? 'dot dot-warn' : 'dot dot-live';
  } catch (e) {
    text.textContent = `Firmware index unavailable (${e.message})`;
    dot.className = 'dot dot-err';
  }
  render();
}

// ─────────────────────────────────────────────────────── events
function wireEvents() {
  $('connectBtn').onclick = connect;
  $('demoBtn').onclick = startDemo;
  $('disconnectBtn').onclick = () => bus.close();
  $('scanBtn').onclick = doScan;
  $('scanBtn2').onclick = doScan;
  $('switchPortBtn').onclick = connect;
  $('rescanInfoBtn').onclick = refreshAll;
  $('fixAliasBtn').onclick = doFixAliases;

  for (const b of $('viewToggle').querySelectorAll('.seg')) {
    b.onclick = () => {
      view = b.dataset.view;
      localStorage.setItem('gearotons.view', view);
      render();
    };
  }

  $('consoleToggle').onclick = () => {
    const c = $('console');
    c.dataset.open = c.dataset.open === 'true' ? 'false' : 'true';
  };
  $('clearLog').onclick = () => { $('consoleLines').innerHTML = ''; };

  bus.addEventListener('open', () => {
    connectError(null);
    $('welcome').hidden = true;
    $('workspace').hidden = false;
    $('portPill').hidden = false;
    $('disconnectBtn').hidden = false;
    const info = bus.port.getInfo?.() || {};
    $('portText').textContent = info.simulated
      ? 'Demo mode · 3 simulated motors'
      : info.usbVendorId
        ? `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${info.usbProductId.toString(16).padStart(4, '0')} · 230400 8N1`
        : 'Serial port · 230400 8N1';
    $('portPill').querySelector('.dot').className = info.simulated ? 'dot dot-warn' : 'dot dot-live';
    log('sys', info.simulated ? 'Demo bus attached' : 'Serial port opened at 230400 baud');
    // Deliberately does NOT start a scan. Whoever opened the port owns that, so
    // there is exactly one scan in flight and it belongs to a known bus.
  });

  bus.addEventListener('close', () => {
    $('welcome').hidden = false;
    $('workspace').hidden = true;
    $('portPill').hidden = true;
    $('disconnectBtn').hidden = true;
    log('sys', 'Serial port closed');
  });

  bus.addEventListener('log', (e) => {
    const { dir, text, cls } = e.detail;
    if (cls === 'raw' && !$('showRaw').checked) return;
    log(dir, text, cls);
  });

  navigator.serial?.addEventListener('disconnect', (e) => {
    if (e.target === bus.port) {
      banner('err', 'The serial adapter was unplugged.');
      bus.close();
    }
  });

  fleet.addEventListener('motors', scheduleRender);
  fleet.addEventListener('motor-updated', scheduleRender);
  fleet.addEventListener('warning', (e) => banner('warn', e.detail.message));
  fleet.addEventListener('scan-progress', (e) => {
    const { step, totalSteps, label } = e.detail;
    showProgress(label, step, totalSteps);
  });
}

// ─────────────────────────────────────────────────────── input lock
// While a command is in flight — above all during the ~300 ms a motor spends
// restarting — nothing else may go out on the bus. Any addressed packet that
// arrives inside a motor's bootloader window pins it in the bootloader instead of
// letting the application start.
//
// Clicks are swallowed rather than the controls being disabled: greying out every
// button on a 35-motor page for a fraction of a second is far more distracting
// than a click that quietly does nothing.
let inputLocks = 0;

function installInputLock() {
  const swallow = (e) => {
    if (!inputLocks) return;
    if (e.target.closest('button, input, select, textarea, a, label, .sum-row')) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  // Capture phase, so it runs before any handler the controls have registered.
  for (const type of ['click', 'pointerdown', 'mousedown', 'keydown']) {
    document.addEventListener(type, (e) => {
      if (type === 'keydown' && !['Enter', ' '].includes(e.key)) return;
      swallow(e);
    }, true);
  }
}

async function withInputLock(fn) {
  inputLocks++;
  try { return await fn(); } finally { inputLocks--; }
}

function log(dir, text, cls = '') {
  const box = $('consoleLines');
  const line = el('div', `l-${cls === 'raw' ? 'raw' : dir === 'tx' ? 'tx' : dir === 'rx' ? 'rx' : 'sys'}`);
  const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
  line.textContent = `${stamp}  ${dir === 'tx' ? '→' : dir === 'rx' ? '←' : '·'}  ${text}`;
  box.appendChild(line);
  while (box.childElementCount > 800) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
  $('consoleMeta').textContent = text.slice(0, 60);
}

// ─────────────────────────────────────────────────────── actions
async function connect() {
  connectError(null);
  try {
    const port = await navigator.serial.requestPort();
    await prepareForNewPort();
    await bus.open(port);
    await doScan();
  } catch (e) {
    if (e.name === 'NotFoundError') return;   // the picker was dismissed
    connectError(explainOpenFailure(e));
  }
}

/**
 * Connection failures cannot use banner(): that lives inside #workspace, which is
 * hidden until a port is open, so every failed connect was silently swallowed and
 * looked to the operator like the button did nothing.
 */
function connectError(html) {
  const box = $('connectError');
  box.hidden = !html;
  box.innerHTML = html || '';
}

/** Turn a Web Serial open() failure into something actionable. */
function explainOpenFailure(e) {
  const name = e.name || '';
  // Chrome reports an already-open port as a generic failure, and it is by far
  // the most common cause: the same port can only be open in one tab at a time.
  if (name === 'InvalidStateError' || /already open/i.test(e.message)) {
    return `<div><b>That port is already open somewhere else.</b>
      A serial port can only be held by one page at a time. Close any other tab running this tool
      (or press Disconnect there), then try again. Other serial software on the machine will block it too.</div>`;
  }
  if (name === 'NetworkError') {
    return `<div><b>The port could not be opened.</b>
      It is usually held by another tab or another program, or the adapter was unplugged.
      Close anything else using it and try again. <span class="mono">${e.message}</span></div>`;
  }
  if (name === 'SecurityError') {
    return `<div><b>Permission was refused for that port.</b> Grant access when Chrome asks, or clear the
      site's serial permissions and pair it again.</div>`;
  }
  return `<div><b>Could not open the port.</b> <span class="mono">${name}: ${e.message}</span></div>`;
}

/**
 * Get ready to point the app at a different port: wait out the start-up
 * auto-reconnect, unwind any scan in flight, and drop everything learned from
 * the old bus. The clear is unconditional — motors from a previous port are
 * meaningless on the new one, and leaving them behind shows them as "absent"
 * alongside the real ones.
 */
async function prepareForNewPort() {
  await booting;                 // never race the start-up auto-reconnect
  if (scanning) {
    scanAbort?.abort();
    for (let i = 0; i < 60 && scanning; i++) await new Promise((r) => setTimeout(r, 100));
  }
  fleet.motors.clear();
  clearBanner();
  render();
}

async function startDemo() {
  await prepareForNewPort();
  await bus.open(new SimulatedPort(demoMotors()));
  banner('info', 'Demo mode: three simulated motors speaking the real protocol. Every byte on the bus console is genuine — only the hardware is fake.');
  await doScan();
}

async function doScan() {
  if (scanning) return;
  scanning = true;
  scanAbort = new AbortController();
  clearBanner();
  setBusyButtons(true);
  try {
    await withInputLock(() => fleet.scan({ signal: scanAbort.signal }));
    const n = fleet.list.filter((m) => m.present).length;
    if (n) {
      // No success banner: the count is already the headline of the summary card,
      // and a banner that appears then vanishes on the next action shifts the
      // whole table down and back up again.
      // Remember which adapter actually had motors, so the next reload reopens
      // this one rather than a same-looking sibling with nothing on it.
      try {
        const i = (await bus.knownPorts()).indexOf(bus.port);
        if (i >= 0) localStorage.setItem('gearotons.portIndex', String(i));
      } catch { /* not important enough to fail a scan over */ }
    }
  } catch (e) {
    if (!scanAbort.signal.aborted) banner('err', `Scan failed: ${e.message}`);
  } finally {
    scanning = false;
    scanAbort = null;
    hideProgress();
    setBusyButtons(false);
    render();
  }
}

async function refreshAll() {
  setBusyButtons(true);
  try {
    const present = fleet.list.filter((m) => m.present);
    for (let i = 0; i < present.length; i++) {
      showProgress(`Reading motor ${i + 1} of ${present.length}`, i + 1, present.length);
      await withInputLock(() => fleet.refresh(present[i]));
    }
  } finally {
    hideProgress();
    setBusyButtons(false);
    render();
  }
}

async function doUpgrade(motors, release = null) {
  if (!motors.length) return;

  const rows = motors.map((m) =>
    `<tr><td>${m.info?.productCode || '?'} · ${idHex(m.uniqueId).slice(-8)}</td>` +
    `<td class="plan-keep">${(m.firmwareVersion || []).join('.')}</td>` +
    `<td class="plan-change">${(release || m.firmware.release).versionStr}</td></tr>`).join('');
  const mismatch = motors.filter((m) => !release && m.firmware.confidence !== 'exact');

  // Whether this runs as one broadcast or as N unicast writes is decided in
  // Fleet.upgrade; say which so the timing is not a surprise.
  const first = motors[0];
  const matchingOnBus = fleet.list.filter((m) =>
    m.present && m.info && first.info &&
    (m.info.productCode || '').trim() === (first.info.productCode || '').trim() &&
    m.info.firmwareCompatibility === first.info.firmwareCompatibility);
  const chosen = new Set(motors.map((m) => m.key));
  const broadcast = matchingOnBus.length > 1 && matchingOnBus.every((m) => chosen.has(m.key));

  const ok = await confirmDialog(
    `${release ? 'Flash' : 'Update'} ${motors.length} motor${motors.length === 1 ? '' : 's'}?`,
    `<table class="plan-table"><tr><th>Motor</th><th>From</th><th>To</th></tr>${rows}</table>` +
    (mismatch.length
      ? `<p style="color:var(--warn);margin-top:14px">${mismatch.length} motor(s) have no build for their exact hardware revision. Review before continuing.</p>`
      : '') +
    `<p class="hint" style="margin-top:14px">Keep the motors powered throughout. ` +
    (broadcast
      ? `All ${motors.length} are written together in one broadcast pass — about 9 seconds for the whole bus.`
      : `Written one at a time, addressed by unique ID — about 6 seconds each, and no other motor is touched.`) +
    `</p>`);
  if (!ok) return;

  setBusyButtons(true);
  clearBanner();
  try {
    const results = await withInputLock(() => fleet.upgrade(motors, {
      release,
      onProgress: (p) => {
        if (p.stage === 'download') showProgress(`Downloading ${p.label}`, 0, 0);
        else if (p.stage === 'flash') showProgress(`Writing ${p.label} — page ${p.page} of ${p.pages}`, p.page, p.pages);
        else if (p.stage === 'verify') showProgress(`Verifying ${p.label}`, 1, 1);
      },
    }));
    const failed = results.filter((r) => !r.ok);
    if (failed.length) await reportUpgradeFailures(results, failed);
    else banner('ok', `All ${results.length} motor${results.length === 1 ? '' : 's'} verified on ${results[0].expected}.`);
  } catch (e) {
    banner('err', `Upgrade failed: ${e.message}`);
  } finally {
    hideProgress();
    setBusyButtons(false);
    render();
  }
}

/**
 * Work out why one motor did not end up on the image that was just written, and
 * what to do about it. The distinctions matter: a motor sitting in its bootloader
 * is safe and re-flashable, whereas one still on its old version never entered
 * the bootloader at all — different causes, different fixes.
 */
function diagnoseUpgrade(r) {
  if (r.inBootloader) {
    return {
      cause: 'Stuck in the bootloader',
      detail: `Reports ${r.actual} (the bootloader's own version). The application image failed its ` +
              'CRC check, so the bootloader refused to start it — almost always a page write that did not land.',
      advice: 'Retry the flash. Only pages 5 and up are ever written, so the bootloader itself is intact and the motor is not bricked.',
      severity: 'warn',
    };
  }
  if (!r.responded) {
    return {
      cause: 'No answer after the upgrade',
      detail: r.error ? `Verification read failed: ${r.error}` : 'The motor did not reply when its version was read back.',
      advice: 'It may still have been rebooting. Scan the bus again; if it stays silent, check its power and the A/B wiring at that node.',
      severity: 'err',
    };
  }
  if (r.before && r.actual === r.before) {
    return {
      cause: 'Never took the new image',
      detail: `Still on ${r.actual}, the version it started from.`,
      advice: 'It most likely missed the ~250 ms bootloader window after the reset, or its model and compatibility code do not match this image. ' +
              'Retry with nothing else talking on the bus; the retry addresses each motor individually and acknowledges every page.',
      severity: 'warn',
    };
  }
  return {
    cause: 'Unexpected version',
    detail: `Expected ${r.expected} but it reports ${r.actual}.`,
    advice: 'Retry the flash. If it keeps happening, check the product code and compatibility code — the bootloader accepts any image whose header matches those two fields.',
    severity: 'warn',
  };
}

/** Report what went wrong per motor. Whether to try again is the operator's call. */
async function reportUpgradeFailures(results, failed) {
  const okCount = results.length - failed.length;
  const rows = failed.map((f) => {
    const d = diagnoseUpgrade(f);
    return `<tr>
      <td>${f.motor.info?.productCode || '?'} · ${idHex(f.motor.uniqueId).slice(-8)}</td>
      <td class="${d.severity === 'err' ? 'plan-change' : 'plan-keep'}">${f.actual ?? 'no answer'}</td>
      <td>${d.cause}</td></tr>`;
  }).join('');

  // One explanation per distinct cause, rather than repeating it 30 times.
  const causes = new Map();
  for (const f of failed) {
    const d = diagnoseUpgrade(f);
    if (!causes.has(d.cause)) causes.set(d.cause, d);
  }
  const explain = [...causes.values()].map((d) =>
    `<p style="margin:10px 0 0"><b>${d.cause}.</b> ${d.detail} <span style="color:var(--accent)">${d.advice}</span></p>`).join('');

  banner(okCount ? 'warn' : 'err',
    `${okCount} of ${results.length} motors verified on ${results[0].expected}. ` +
    `${failed.length} did not — see the details.`);

  await confirmDialog(
    `${failed.length} motor${failed.length === 1 ? '' : 's'} did not take the update`,
    `<p>${okCount} of ${results.length} verified on <b>${results[0].expected}</b>.</p>
     <table class="plan-table"><tr><th>Motor</th><th>Reports</th><th>Diagnosis</th></tr>${rows}</table>
     ${explain}
     <p class="hint" style="margin-top:14px">This should not normally happen. You can run the update again from the
     Firmware button on each motor, or from the broadcast card. If it keeps happening, or anything else about the
     setup looks wrong, contact support with the diagnosis above and the bus console output.</p>`,
    { okLabel: 'Close', cancelLabel: null });
}

/**
 * Choose how to number the whole bus. Offered when nothing is actually broken —
 * repairing conflicts skips this and keeps existing aliases wherever it can.
 */
async function chooseAliasScheme(motorCount) {
  const schemes = Fleet.ALIAS_SCHEMES;
  const keys = Object.keys(schemes);
  let picked = 'numeric';

  $('schemeSub').textContent =
    `All ${motorCount} motors will be renumbered in the order shown on screen. ` +
    `Aliases must land in 0–251; 252–254 are reserved and 255 means "no alias".`;

  const list = $('schemeList');
  list.innerHTML = '';
  for (const k of keys) {
    const row = el('label', 'fw-opt');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'scheme';
    radio.value = k;
    radio.checked = k === picked;
    row.appendChild(radio);
    const mid = el('div');
    mid.appendChild(el('div', 'fw-opt-v', schemes[k].label));
    mid.appendChild(el('div', 'fw-opt-meta', schemes[k].hint));
    row.appendChild(mid);
    row.appendChild(el('div'));
    list.appendChild(row);
  }

  const startInput = $('schemeStart');
  const preview = () => {
    picked = list.querySelector('input:checked')?.value || 'numeric';
    const def = schemes[picked];
    try {
      const values = def.values(startInput.value || def.defaultStart);
      if (!values.length) throw new Error('not a valid start for this scheme');
      const shown = values.slice(0, Math.min(6, motorCount)).map(aliasText).join(', ');
      $('schemePreview').textContent = values.length < motorCount
        ? `Only ${values.length} aliases available from here, but ${motorCount} motors need one.`
        : `${shown}${motorCount > 6 ? ' …' : ''}  (${values.length} available)`;
      $('schemeOk').disabled = values.length < motorCount;
    } catch (e) {
      $('schemePreview').textContent = String(e.message);
      $('schemeOk').disabled = true;
    }
  };
  list.onchange = () => { startInput.value = schemes[list.querySelector('input:checked').value].defaultStart; preview(); };
  startInput.oninput = preview;
  startInput.value = schemes[picked].defaultStart;
  preview();

  const ok = await openDialog($('aliasSchemeDialog'));
  list.onchange = null;
  startInput.oninput = null;
  if (!ok) return null;
  return { scheme: list.querySelector('input:checked').value, start: startInput.value };
}

async function doFixAliases() {
  const present = fleet.list.filter((m) => m.present);
  if (!present.length) return;
  const broken = present.filter((m) => m.duplicateAlias || m.alias === 255).length;

  let opts = {};
  if (!broken) {
    opts = await chooseAliasScheme(present.length);
    if (!opts) return;
  }

  let plan;
  try { plan = fleet.planAliases(opts); } catch (e) { return banner('err', e.message); }
  const changes = plan.filter((p) => p.change);
  if (!changes.length) return banner('ok', 'Every motor already has the alias this scheme would give it.');

  const rows = plan.map((p) =>
    `<tr><td>${idHex(p.motor.uniqueId).slice(-8)}</td>` +
    `<td class="plan-keep">${aliasText(p.from)}</td>` +
    `<td class="${p.change ? 'plan-change' : 'plan-keep'}">${p.change ? aliasText(p.to) : 'unchanged'}</td></tr>`).join('');
  const ok = await confirmDialog(`Assign ${changes.length} alias${changes.length === 1 ? '' : 'es'}?`,
    `<table class="plan-table"><tr><th>Motor</th><th>Now</th><th>After</th></tr>${rows}</table>` +
    `<p class="hint" style="margin-top:14px">Each motor saves the alias to flash and reboots, one at a time.` +
    (broken ? ' Motors that already hold a unique alias are left alone.' : '') + `</p>`);
  if (!ok) return;

  setBusyButtons(true);
  // Renumbering changes the very field the table is sorted by, so rows would
  // leapfrog each other after every single motor. Hold the order still until the
  // whole run is finished.
  freezeOrder(fleet.list);
  try {
    await withInputLock(() => fleet.applyAliasPlan(plan, {
      onStep: ({ index, total, plan: p }) =>
        showProgress(`Setting alias ${aliasText(p.to)} on ${idHex(p.motor.uniqueId).slice(-8)}`, index + 1, total),
    }));
    banner('ok', `Assigned ${changes.length} alias${changes.length === 1 ? '' : 'es'}.`);
  } catch (e) {
    banner('err', `Could not assign aliases: ${e.message}`);
  } finally {
    hideProgress();
    setBusyButtons(false);
    thawOrder();
    render();
  }
}

/**
 * Run a single-motor command. Success is confirmed on the motor itself rather
 * than with a banner — with 35 motors a global message tells you that something
 * worked but not which one, and it is noise when firing commands in sequence.
 * Failures still raise a banner, because those carry text you need to read.
 *
 * @param onResult optional; return a string to also surface a banner for
 *                 results that carry a measurement worth reading (the alive
 *                 test), rather than a bare confirmation.
 */
async function runAction(motor, cmd, fn, onResult) {
  clearBanner();
  let ok = false;
  let acked = false;
  // Some operations know they succeeded well before they finish — a reset is
  // confirmed the instant the motor answers, but then spends 300 ms restarting.
  // Let those report it straight away rather than at the end.
  const ackNow = () => {
    if (acked) return;
    acked = true;
    acknowledge(motor.key, cmd);
  };
  try {
    await withInputLock(async () => {
      const r = await fn(ackNow);
      ok = true;
      const msg = onResult?.(r);
      if (msg) banner(msg.kind || 'ok', msg.text ?? msg);
    });
  } catch (e) {
    banner('err', `${aliasLabel(motor)}: ${e.message}${errorHint(e)}`);
  }
  render();
  if (ok && !acked) acknowledge(motor.key, cmd);
}

const errorHint = (e) => {
  const info = e.code != null && errorCodes?.get(e.code);
  return info ? ` — ${info.short_desc || info.enum}. ${info.solutions?.[0] || ''}` : '';
};

// ─────────────────────────────────────────────────────── rendering
// A single command emits several events (busy on, busy off, values refreshed).
// Rebuilding the list for each one made a bulk operation flicker, so collapse
// them into one repaint per frame.
let renderTimer = null;
function scheduleRender() {
  // setTimeout rather than rAF so a background tab still repaints.
  if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 16);
}

// While a bulk operation rewrites the field the list is sorted by, hold the row
// order still — otherwise rows leapfrog each other after every motor.
let orderLock = null;
function freezeOrder(motors) {
  orderLock = new Map(motors.map((m, i) => [m.key, i]));
}
function thawOrder() { orderLock = null; }

function render() {
  // Drop any queued repaint. Without this a coalesced render left over from the
  // command that just finished fires ~16 ms later and rebuilds the list, wiping
  // the acknowledgement that runAction applied immediately after this call — the
  // glow and checkmark flashed for one frame instead of playing out.
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }

  const motors = fleet.list;
  const present = motors.filter((m) => m.present);
  const upgradable = present.filter((m) => m.updateAvailable);

  $('emptyState').hidden = !!present.length || scanning;
  // An empty bus is far more often the wrong adapter than bad wiring, so say so
  // when there is more than one to choose from.
  if (!$('emptyState').hidden) {
    const many = knownPortCount > 1;
    $('switchPortBtn').hidden = !many;
    $('emptyHint').textContent = many
      ? `Nothing answered on this adapter. ${knownPortCount} adapters are paired with this page and they look identical over USB, so this may simply be the wrong one — try another. Otherwise check that the bus is powered and wired A to A, B to B.`
      : 'Check that the bus is powered and the adapter is wired A to A, B to B, then scan again.';
  }

  // Always present: it repairs conflicts when there are any, and otherwise
  // renumbers the whole bus to a scheme of your choosing.
  const aliasIssues = present.filter((m) => m.duplicateAlias || m.alias === 255).length;
  const aliasBtn = $('fixAliasBtn');
  aliasBtn.disabled = !present.length || scanning;
  aliasBtn.textContent = aliasIssues
    ? `Fix ${aliasIssues} alias issue${aliasIssues === 1 ? '' : 's'}`
    : 'Reassign aliases';
  aliasBtn.classList.toggle('btn-accent', aliasIssues > 0);

  for (const b of $('viewToggle').querySelectorAll('.seg')) {
    b.setAttribute('aria-pressed', String(b.dataset.view === view));
  }

  renderSummary(present);
  renderBroadcast(present);

  const grid = $('grid');
  const tableWrap = $('tableWrap');
  grid.hidden = view !== 'cards';
  tableWrap.hidden = view !== 'table';

  // Rebuilding throws away the scroll position, which is jarring 20 rows down a
  // 35-motor table while a bulk operation runs.
  const scroll = tableWrap.scrollTop;

  // Clear BOTH. Leaving the inactive view populated means two elements carry the
  // same data-motor, and acknowledge()'s lookup finds whichever comes first in
  // the document — which is the hidden one, so the confirmation played where it
  // could not be seen.
  grid.innerHTML = '';
  tableWrap.innerHTML = '';
  if (view === 'cards') {
    for (const m of motors) grid.appendChild(motorCard(m));
  } else if (motors.length) {
    tableWrap.appendChild(motorTable(motors));
    tableWrap.scrollTop = scroll;
  }
}

// ─────────────────────────────────────────────────────── summary
/** Group motors by a derived key and return rows sorted by descending count. */
function tallyBy(motors, fn) {
  const map = new Map();
  for (const m of motors) {
    const k = fn(m) ?? '—';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(m);
  }
  return [...map.entries()]
    .map(([label, members]) => ({ label, members, n: members.length }))
    .sort((a, b) => b.n - a.n || String(a.label).localeCompare(String(b.label)));
}

function renderSummary(present) {
  const box = $('summary');
  const absent = fleet.list.filter((m) => !m.present).length;
  if (!present.length && !absent) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '';

  // ── headline
  const head = el('div', 'sum-headline');
  head.appendChild(el('div', 'sum-count', String(present.length)));
  head.appendChild(el('div', 'sum-count-label', present.length === 1 ? 'motor on the bus' : 'motors on the bus'));

  const health = el('div', 'sum-health');
  const chip = (kind, text, title) => {
    const c = el('span', `tag tag-${kind}`, text);
    if (title) c.title = title;
    health.appendChild(c);
  };
  const faults = present.filter((m) => m.status?.fatalErrorCode);
  const updates = present.filter((m) => m.updateAvailable);
  const dupes = present.filter((m) => m.duplicateAlias);
  const noAlias = present.filter((m) => m.alias === 255);
  const unread = present.filter((m) => !m.info);

  if (faults.length) chip('err', `${faults.length} fatal error${faults.length === 1 ? '' : 's'}`,
    faults.map((m) => `${idHex(m.uniqueId)} → code ${m.status.fatalErrorCode}`).join('\n'));
  if (absent) chip('mute', `${absent} absent`, 'Seen in an earlier scan but not answering now');
  if (updates.length) chip('info', `${updates.length} update${updates.length === 1 ? '' : 's'} available`);
  if (dupes.length) {
    // The common case on a fresh rack is every motor sharing one alias, which
    // reads far better than "35 duplicate alias".
    const shared = [...new Set(dupes.map((m) => m.alias))];
    chip('warn', shared.length === 1
      ? `${dupes.length} share alias ${shared[0]}`
      : `${dupes.length} with duplicate aliases`);
  }
  if (noAlias.length) chip('warn', `${noAlias.length} without an alias`);
  if (unread.length) chip('mute', `${unread.length} not read`);
  if (!faults.length && present.length) chip('ok', 'no fatal errors');
  head.appendChild(health);
  box.appendChild(head);

  // ── breakdowns. Clicking a row selects those motors, which is how you get
  // from "3 motors are on an old firmware" to acting on exactly those three.
  const groups = el('div', 'sum-groups');
  const addGroup = (title, rows, fmt = (r) => r.label) => {
    if (!rows.length) return;
    const g = el('div');
    g.appendChild(el('div', 'sum-group-title', title));
    const list = el('div', 'sum-rows');
    const max = Math.max(...rows.map((r) => r.n));
    for (const r of rows) {
      const btn = el('div', 'sum-row');
      if (rows.length > 1 && r.n < max) btn.classList.add('is-outlier');
      btn.appendChild(el('span', null, fmt(r)));
      btn.appendChild(el('span', 'sum-row-n', String(r.n)));
      const bar = el('div', 'sum-row-bar');
      const fill = el('i');
      fill.style.width = `${(r.n / max) * 100}%`;
      bar.appendChild(fill);
      btn.appendChild(bar);
      list.appendChild(btn);
    }
    g.appendChild(list);
    groups.appendChild(g);
  };

  const withInfo = present.filter((m) => m.info);
  addGroup('Model', tallyBy(withInfo, (m) => m.info.productCode));
  addGroup('Firmware', tallyBy(present.filter((m) => m.firmwareVersion), (m) => m.firmwareVersion.join('.')),
    (r) => r.label + (r.members[0].updateAvailable ? ' ↑' : ''));
  addGroup('Hardware', tallyBy(withInfo, (m) => `v${m.info.hardwareVersion}`));

  // Environmental ranges only mean something once there is a spread.
  const volts = present.map((m) => m.voltage).filter((v) => v != null);
  const temps = present.map((m) => m.temperature).filter((v) => v != null);
  if (volts.length || temps.length) {
    const g = el('div');
    g.appendChild(el('div', 'sum-group-title', 'Range'));
    const list = el('div', 'sum-rows');
    const rangeRow = (label, arr, unit, dp = 1) => {
      if (!arr.length) return;
      const lo = Math.min(...arr), hi = Math.max(...arr);
      const row = el('div', 'sum-row');
      row.style.cursor = 'default';
      row.appendChild(el('span', null, lo === hi ? `${lo.toFixed(dp)} ${unit}` : `${lo.toFixed(dp)}–${hi.toFixed(dp)} ${unit}`));
      row.appendChild(el('span', 'sum-row-n', label));
      list.appendChild(row);
    };
    rangeRow('supply', volts, 'V');
    rangeRow('temp', temps, '°C', 0);
    g.appendChild(list);
    groups.appendChild(g);
  }

  box.appendChild(groups);
}

// ─────────────────────────────────────────────────────── broadcast
/**
 * Commands addressed to alias 255. No device answers a broadcast, so there is
 * nothing to confirm against — the acknowledgement fires unconditionally once
 * the bytes are on the wire, and the card says so rather than implying receipt.
 */
function renderBroadcast(present) {
  const box = $('broadcast');
  if (!present.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '';
  box.dataset.motor = '__broadcast__';

  const title = el('div', 'bcast-title');
  const h = el('b');
  h.appendChild(el('span', null, 'Broadcast'));
  h.appendChild(el('span', 'bcast-badge', 'alias 255'));
  title.appendChild(h);
  title.appendChild(el('span', null, `Sent to all ${present.length} motors at once. Nothing replies to a broadcast, so this confirms the command was sent, not that it was received.`));
  box.appendChild(title);

  const acts = el('div', 'bcast-actions');
  const add = (cmd, label, cls, run) => {
    const b = actionBtn({
      cmd, label, cls, title: `${label} — all ${present.length} motors`,
      disabled: present.some((m) => m.busy),
      onclick: run,
    });
    acts.appendChild(b);
  };

  const fire = async (cmd, fn) => {
    clearBanner();
    setBusyButtons(true);
    try {
      await withInputLock(fn);
      acknowledge('__broadcast__', cmd);
    } catch (e) {
      banner('err', `Broadcast failed: ${e.message}`);
    } finally {
      setBusyButtons(false);
      render();
      acknowledge('__broadcast__', cmd);
    }
  };

  add('identify', 'Identify all', '', () => fire('identify', () => fleet.broadcast('identify')));

  add('alive', 'Alive test all', 'btn-accent', async () => {
    const ok = await confirmDialog(`Spin all ${present.length} motors?`,
      `<p>Every motor energises and turns one revolution at the same time.</p>
       <p style="color:var(--warn)">All ${present.length} draw current simultaneously — make sure the supply can take it.</p>
       <p class="hint">Nothing reports back on a broadcast, so there is no pass/fail. Use the per-motor alive test for a measured result.</p>`);
    if (ok) fire('alive', () => fleet.broadcast('alive'));
  });

  add('alias', 'Set alias on all', '', async () => {
    const v = await promptNumber('Broadcast alias',
      'Every motor gets this same alias. Use 255 to clear the alias on all of them.', 0, 255);
    if (v == null) return;
    if (v >= 252 && v <= 254) {
      return banner('err', `${v} is reserved — the firmware answers it with fatal error 50 and locks every motor until reset. Use 0–251, or 255 to clear.`);
    }
    const ok = await confirmDialog(
      v === 255 ? `Clear the alias on all ${present.length} motors?` : `Set alias ${aliasText(v)} on all ${present.length} motors?`,
      v === 255
        ? `<p>Alias 255 means "no alias": every motor stops answering to any alias.</p>
           <p>Unique-ID addressing is unaffected, so everything in this tool keeps working and you can renumber them again at any time.</p>`
        : `<p style="color:var(--warn)">This gives every motor the same alias, so they all become duplicates and none can be
           addressed individually by alias afterwards.</p>
           <p>Unique-ID addressing still works, so this is recoverable with "Fix alias issues".</p>`);
    if (ok) fire('alias', () => fleet.broadcast('alias', { alias: v }));
  });

  add('firmware', 'Firmware…', '', () => chooseBroadcastFirmware());

  add('reset', 'Reset all', 'btn-ghost', () => fire('reset', () => fleet.broadcast('reset')));

  box.appendChild(acts);
  applyAck(box, '__broadcast__');
}

// ─────────────────────────────────────────────────────── firmware picker
/**
 * Pick any build the motor's bootloader would accept — newer or older. The
 * device only checks model code and compatibility code, so downgrades are
 * legitimate; hardware revision is shown but not enforced, because it is the
 * host's job to get that right.
 */
/** Paint the release list into the dialog and return the chosen release, or null. */
function fillFirmwareList(releases) {
  const list = $('fwList');
  list.innerHTML = '';
  const preselect = releases.find((r) => r.isNewer) || releases.find((r) => !r.isCurrent) || releases[0];
  for (const r of releases) {
    const row = el('label', 'fw-opt');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'fwpick';
    radio.value = r.name;
    radio.checked = r === preselect;
    row.appendChild(radio);

    const mid = el('div');
    mid.appendChild(el('div', 'fw-opt-v', r.versionStr));
    mid.appendChild(el('div', 'fw-opt-meta', `${r.model} · hw ${r.hardware} · ${(r.size / 1024).toFixed(1)} kB`));
    row.appendChild(mid);

    const tags = el('div', 'fw-opt-tags');
    if (r.installedOn > 0 && r.installedOn < r.groupSize) {
      // Mixed group: "newer" and "older" would be relative to an arbitrary
      // reference motor, so report the actual spread instead.
      tags.appendChild(el('span', 'tag tag-info', `on ${r.installedOn} of ${r.groupSize}`));
    } else if (r.isCurrent) {
      tags.appendChild(el('span', 'tag tag-info', r.groupSize > 1 ? 'installed on all' : 'installed'));
    } else if (r.isNewer === true) {
      tags.appendChild(el('span', 'tag tag-ok', 'newer'));
    } else if (r.isNewer === false) {
      tags.appendChild(el('span', 'tag tag-mute', 'older'));
    }
    if (r.hardwareMatches === false) tags.appendChild(el('span', 'tag tag-warn', `hw ${r.hardware}`));
    row.appendChild(tags);
    list.appendChild(row);
  }
  return () => releases.find((r) => r.name === list.querySelector('input:checked')?.value) || null;
}

/** Warn before flashing a build whose hardware revision differs from the target. */
async function confirmHardwareMismatch(release, hwVersion) {
  return confirmDialog('Hardware revision does not match',
    `<p>This build is for hardware <b>${release.hardware}</b> but the motor reports <b>v${hwVersion}</b>.</p>
     <p>The bootloader only checks the model and compatibility code, so it will accept this image — getting the
     hardware revision right is the host's responsibility, not the device's.</p>`);
}

/**
 * Pick any build one motor's bootloader would accept — newer or older. The device
 * only checks model code and compatibility code, so downgrades are legitimate;
 * hardware revision is shown but not enforced, because it is the host's job.
 *
 * Always writes just this motor, by unique ID. Bus-wide flashing lives on the
 * broadcast card, where its scope is unmistakable.
 */
async function chooseFirmware(motor) {
  const releases = fleet.compatibleReleases(motor);
  if (!releases.length) {
    return banner('warn', `No firmware in the repository matches ${motor.info?.productCode} with compatibility code ${motor.info?.firmwareCompatibility}.`);
  }

  $('fwTitle').textContent = 'Choose firmware';
  $('fwSub').textContent =
    `${motor.info.productCode} · hardware v${motor.info.hardwareVersion} · compatibility code ${motor.info.firmwareCompatibility} · ` +
    `currently ${motor.firmwareVersion?.join('.') ?? 'unknown'}`;
  $('fwGroupWrap').hidden = true;
  $('fwHint').textContent = 'This motor only, addressed by unique ID. No other motor on the bus is touched.';

  const getPicked = fillFirmwareList(releases);
  if (!(await openDialog($('fwDialog')))) return;
  const picked = getPicked();
  if (!picked) return;
  if (!picked.hardwareMatches && !(await confirmHardwareMismatch(picked, motor.info.hardwareVersion))) return;

  await doUpgrade([motor], picked);
}

/**
 * Broadcast a firmware image to every motor of one type at once. The bootloader
 * filters each page on model code + compatibility code, so a single pass writes
 * all of them and anything else on the bus ignores it.
 */
async function chooseBroadcastFirmware() {
  const present = fleet.list.filter((m) => m.present && m.info);
  if (!present.length) return banner('warn', 'Scan the bus first.');

  // One group per (model, compatibility code) — the pair the bootloader checks.
  const groups = new Map();
  for (const m of present) {
    const key = `${(m.info.productCode || '').trim()}|${m.info.firmwareCompatibility}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const entries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  const sel = $('fwGroup');
  sel.innerHTML = '';
  for (const [key, members] of entries) {
    const [model, scc] = key.split('|');
    const versions = [...new Set(members.map((m) => m.firmwareVersion?.join('.')))].join(', ');
    sel.appendChild(Object.assign(el('option'), {
      value: key,
      textContent: `${model} · compatibility ${scc} — ${members.length} motor${members.length === 1 ? '' : 's'} on ${versions}`,
    }));
  }
  $('fwGroupWrap').hidden = entries.length === 1;

  const paint = () => {
    const members = groups.get(sel.value);
    const ref = members[0];
    const versions = new Set(members.map((m) => m.firmwareVersion?.join('.')));
    const uniform = versions.size === 1;
    const releases = fleet.compatibleReleases(ref).map((r) => {
      const v = r.version.join('.');
      const installedOn = members.filter((m) => m.firmwareVersion?.join('.') === v).length;
      return {
        ...r,
        installedOn,
        groupSize: members.length,
        isCurrent: installedOn === members.length,
        // Direction is only meaningful when the whole group starts from one version.
        isNewer: uniform ? r.isNewer : undefined,
        hardwareMatches: members.every((m) => fwHwKey(m.info.hardwareVersion) === fwHwKey(r.hardware)),
      };
    });
    $('fwSub').textContent =
      `Broadcast to all ${members.length} ${ref.info.productCode} motor${members.length === 1 ? '' : 's'} ` +
      `with compatibility code ${ref.info.firmwareCompatibility}, in one pass. ` +
      (uniform ? `All currently on ${[...versions][0]}.` : `Currently on ${[...versions].sort().join(', ')}.`);
    $('fwHint').textContent =
      'Every motor of this type on the bus is written, whatever is selected in the list. ' +
      'Motors of any other type ignore it. Keep everything powered until it finishes.';
    return { releases, members, getPicked: fillFirmwareList(releases) };
  };

  let state = paint();
  sel.onchange = () => { state = paint(); };

  $('fwTitle').textContent = 'Broadcast firmware';
  const ok = await openDialog($('fwDialog'));
  sel.onchange = null;
  if (!ok) return;

  const picked = state.getPicked();
  if (!picked) return;
  const hwList = [...new Set(state.members.map((m) => m.info.hardwareVersion))].join(', ');
  if (!picked.hardwareMatches && !(await confirmHardwareMismatch(picked, hwList))) return;

  await doUpgrade(state.members, picked);
}

/** major.minor of a hardware version, matching the firmware filename convention. */
const fwHwKey = (v) => String(v).split('.').slice(0, 2).join('.');

// ─────────────────────────────────────────────────────── table view
const COLUMNS = [
  { key: 'alias', label: 'Alias', get: (m) => (m.alias === 255 ? Infinity : m.alias) },
  { key: 'model', label: 'Model', get: (m) => m.info?.productCode || '' },
  { key: 'uid', label: 'Unique ID', get: (m) => idHex(m.uniqueId) },
  { key: 'hw', label: 'Hardware', get: (m) => m.info?.hardwareVersion || '' },
  { key: 'serial', label: 'Serial', get: (m) => m.info?.serialNumber ?? -1 },
  { key: 'fw', label: 'Firmware', get: (m) => (m.firmwareVersion || []).join('.') },
  { key: 'volts', label: 'Supply', get: (m) => m.voltage ?? -1 },
  { key: 'temp', label: 'Temp', get: (m) => m.temperature ?? -1 },
  { key: 'status', label: 'Status', get: (m) => (m.status?.fatalErrorCode ? 1 : 0) },
];

const ICONS = {
  identify: 'M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2zM9 21h6',
  alive: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  alias: 'M20.6 13.4 12 22l-9-9V3h10zM7.5 7.5h.01',
  reset: 'M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0',
  firmware: 'M9 3h6v3H9zM4 6h16v12H4zM8 21h8M9.5 10.5h5M9.5 14h5',
  check: 'M4 12.5 9 17.5 20 6.5',
};

const svgIcon = (d) =>
  `<svg viewBox="0 0 24 24" class="ico" fill="none" stroke="currentColor" stroke-width="1.9" ` +
  `stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

/**
 * One action control, used by both views. Carries `data-cmd` so the
 * acknowledgement can find it again after the re-render that follows a command,
 * and holds both the normal icon and the check that replaces it.
 */
function actionBtn({ cmd, title, label, cls = '', onclick, disabled }) {
  const b = el('button', label ? `btn btn-sm ${cls}` : `icon-btn ${cls}`);
  b.dataset.cmd = cmd;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.disabled = !!disabled;
  b.innerHTML =
    `<span class="base">${svgIcon(ICONS[cmd])}</span>` +
    `<span class="chk">${svgIcon(ICONS.check)}</span>` +
    (label ? `<span>${label}</span>` : '');
  b.onclick = onclick;
  return b;
}

/**
 * Confirm a command visually: the button that triggered it shows a check, and
 * the motor's card or row glows outward once.
 *
 * Looked up by key rather than held as a reference, because every command
 * re-renders the list several times (busy on, busy off, refreshed values) and
 * the element clicked no longer exists by the time the command returns.
 */
const ACK_MS = 700;
/**
 * Acknowledgements live in state, not in the DOM.
 *
 * Applying the classes directly did not survive: a command emits several events,
 * and any repaint that lands during the animation rebuilds the row and throws the
 * classes away — the glow and checkmark showed for a single frame. Holding the
 * acknowledgement here means every render re-applies it for as long as it should
 * last, however many times the list is rebuilt.
 */
const acks = new Map();   // motor key -> { cmd, startedAt }
window.gearotons.acks = acks;   // visible from devtools alongside bus and fleet

function acknowledge(motorKey, cmd) {
  acks.set(motorKey, { cmd, startedAt: Date.now() });
  render();
  setTimeout(() => {
    const a = acks.get(motorKey);
    if (a && Date.now() - a.startedAt >= ACK_MS) { acks.delete(motorKey); render(); }
  }, ACK_MS + 20);
}

/**
 * Re-apply a live acknowledgement to a freshly built card or row.
 *
 * The negative animation-delay is the point: a rebuilt element starts its CSS
 * animation from zero, so a repaint landing mid-glow replayed the whole thing and
 * the operator saw it flash twice. Offsetting by however long the acknowledgement
 * has already been running makes it resume instead, so it plays exactly once no
 * matter how often the list is rebuilt.
 */
function applyAck(host, key) {
  const a = acks.get(key);
  if (!a) return;
  const elapsed = Date.now() - a.startedAt;
  if (elapsed >= ACK_MS) return;
  host.style.setProperty('--ack-delay', `${-elapsed}ms`);
  host.classList.add('fx-ack');
  host.querySelector(`[data-cmd="${a.cmd}"]`)?.classList.add('on');
}

function motorTable(motors) {
  const rows = orderLock
    ? [...motors].sort((a, b) => (orderLock.get(a.key) ?? 1e9) - (orderLock.get(b.key) ?? 1e9))
    : [...motors].sort((a, b) => {
      const col = COLUMNS.find((c) => c.key === sort.key) || COLUMNS[0];
      const av = col.get(a), bv = col.get(b);
      const d = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv));
      return (d || (a.uniqueId < b.uniqueId ? -1 : 1)) * sort.dir;
    });

  const table = el('table', 'motors');
  const thead = el('thead');
  const hr = el('tr');
  for (const c of COLUMNS) {
    const th = el('th', `sortable col-${c.key}`);
    th.textContent = c.label;
    if (sort.key === c.key) {
      th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending');
      th.appendChild(el('span', 'arrow', sort.dir > 0 ? '↑' : '↓'));
    }
    th.onclick = () => {
      if (sort.key === c.key) sort.dir *= -1;
      else sort = { key: c.key, dir: 1 };
      render();
    };
    hr.appendChild(th);
  }
  hr.appendChild(el('th', null, 'Actions'));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const m of rows) {
    const tr = el('tr', 'fx');
    tr.dataset.motor = m.key;
    tr.dataset.absent = !m.present;
    tr.dataset.busy = !!m.busy;

    // Alias
    const tdAlias = el('td', 'mono');
    if (m.alias === 255) tdAlias.appendChild(el('span', 'tag tag-warn', 'none'));
    else {
      tdAlias.appendChild(el('span', null, String(m.alias)));
      if (m.duplicateAlias) tdAlias.appendChild(el('span', 'tag tag-err', 'dup'));
    }
    tr.appendChild(tdAlias);

    tr.appendChild(el('td', 'mono', m.info?.productCode || '—'));

    const tdUid = el('td', 'mono');
    tdUid.textContent = idHex(m.uniqueId);
    tdUid.style.cursor = 'pointer';
    tdUid.title = 'Click to copy';
    tdUid.onclick = () => {
      navigator.clipboard?.writeText(idHex(m.uniqueId));
      const prev = tdUid.textContent;
      tdUid.textContent = 'copied';
      setTimeout(() => { tdUid.textContent = prev; }, 900);
    };
    tr.appendChild(tdUid);

    tr.appendChild(el('td', 'mono', m.info ? `v${m.info.hardwareVersion}` : '—'));
    tr.appendChild(el('td', 'mono', m.info ? String(m.info.serialNumber) : '—'));

    // Firmware, with the update target inline
    const tdFw = el('td', 'mono');
    tdFw.appendChild(el('span', null, (m.firmwareVersion || []).join('.') || '—'));
    if (m.updateAvailable) {
      tdFw.appendChild(el('span', 'fw-arrow', ' → '));
      tdFw.appendChild(el('span', 'fw-new', m.firmware.release.versionStr));
      if (m.firmware.confidence !== 'exact') tdFw.appendChild(el('span', 'tag tag-warn', 'check hw'));
    }
    tr.appendChild(tdFw);

    tr.appendChild(el('td', 'mono', m.voltage != null ? `${m.voltage.toFixed(1)} V` : '—'));
    tr.appendChild(el('td', 'mono', m.temperature != null ? `${m.temperature} °C` : '—'));

    // Status
    const tdStatus = el('td', 'col-status');
    if (m.busy) {
      const wrap = el('span', 'card-status is-busy');
      wrap.style.padding = '0';
      wrap.style.border = '0';
      wrap.appendChild(el('div', 'spinner'));
      wrap.appendChild(el('span', 'row-note', m.busyLabel || 'Working…'));
      tdStatus.appendChild(wrap);
    } else if (m.error) {
      tdStatus.appendChild(el('span', 'row-note row-err', m.error));
    } else if (!m.present) {
      tdStatus.appendChild(el('span', 'tag tag-mute', 'absent'));
    } else if (m.status?.fatalErrorCode) {
      const info = errorCodes?.get(m.status.fatalErrorCode);
      const t = el('span', 'tag tag-err', `fatal ${m.status.fatalErrorCode}`);
      if (info) t.title = info.long_desc;
      tdStatus.appendChild(t);
    } else if (m.status) {
      tdStatus.appendChild(el('span', 'tag tag-ok', 'healthy'));
      if (m.status.mosfetsEnabled) tdStatus.appendChild(el('span', 'tag tag-info', 'mosfets'));
      if (m.status.inBootloader) tdStatus.appendChild(el('span', 'tag tag-warn', 'bootloader'));
    } else {
      tdStatus.appendChild(el('span', 'tag tag-mute', 'not read'));
    }
    if (m.aliveTest) {
      tdStatus.appendChild(el('span', `tag ${m.aliveTest.passed ? 'tag-ok' : 'tag-err'}`,
        m.aliveTest.passed ? 'alive' : 'test failed'));
    }
    tr.appendChild(tdStatus);

    // Actions
    const tdAct = el('td');
    const acts = el('div', 'td-actions');
    for (const a of motorActions(m, false)) acts.appendChild(a);
    if (m.updateAvailable) {
      const b = el('button', 'btn btn-primary btn-sm', 'Update');
      b.disabled = !m.present;
      b.onclick = () => doUpgrade([m]);
      acts.appendChild(b);
    }
    tdAct.appendChild(acts);
    tr.appendChild(tdAct);

    applyAck(tr, m.key);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function aliasLabel(m) {
  if (m.alias === 255) return `Motor ${idHex(m.uniqueId).slice(-6)}`;
  return `Alias ${aliasText(m.alias)}`;
}

function motorCard(m) {
  const card = el('div', 'card fx');
  card.dataset.motor = m.key;
  card.dataset.busy = !!m.busy;
  card.dataset.absent = !m.present;

  // ── head
  const head = el('div', 'card-head');
  head.appendChild(el('div', 'model-badge', m.info?.productCode || '—'));

  const titles = el('div', 'card-titles');
  const title = el('div', 'card-alias');
  title.appendChild(el('span', null, aliasLabel(m)));
  if (m.duplicateAlias) title.appendChild(el('span', 'tag tag-err', 'duplicate'));
  else if (m.alias === 255) title.appendChild(el('span', 'tag tag-warn', 'no alias'));
  if (!m.present) title.appendChild(el('span', 'tag tag-mute', 'absent'));
  titles.appendChild(title);

  const uid = el('div', 'card-uid', idHex(m.uniqueId));
  uid.title = 'Click to copy the unique ID';
  uid.onclick = () => {
    navigator.clipboard?.writeText(idHex(m.uniqueId));
    uid.textContent = 'copied';
    setTimeout(() => { uid.textContent = idHex(m.uniqueId); }, 900);
  };
  titles.appendChild(uid);
  head.appendChild(titles);
  card.appendChild(head);

  // ── firmware strip
  const strip = el('div', 'fw-strip');
  strip.appendChild(el('span', 'fw-label', 'Firmware'));
  const vers = el('div', 'fw-versions');
  const cur = (m.firmwareVersion || []).join('.') || '—';
  if (m.updateAvailable) {
    vers.appendChild(el('span', 'fw-current', cur));
    vers.appendChild(el('span', 'fw-arrow', '→'));
    vers.appendChild(el('span', 'fw-new', m.firmware.release.versionStr));
    if (m.firmware.confidence !== 'exact') vers.appendChild(el('span', 'tag tag-warn', 'check hw'));
  } else {
    vers.appendChild(el('span', 'fw-uptodate', cur));
    if (m.info && m.firmware?.release) vers.appendChild(el('span', 'tag tag-ok', 'latest'));
    else if (m.info) vers.appendChild(el('span', 'tag tag-mute', 'no release'));
  }
  strip.appendChild(vers);
  if (m.updateAvailable) {
    const b = el('button', 'btn btn-primary btn-sm', 'Update');
    b.disabled = m.busy;
    b.onclick = () => doUpgrade([m]);
    strip.appendChild(b);
  }
  card.appendChild(strip);

  // ── facts
  const facts = el('div', 'facts');
  const addFact = (k, v, muted) => {
    const f = el('div', 'fact');
    f.appendChild(el('div', 'fact-k', k));
    f.appendChild(el('div', `fact-v${muted ? ' muted' : ''}`, v));
    facts.appendChild(f);
  };
  addFact('Hardware', m.info ? `v${m.info.hardwareVersion}` : '—', !m.info);
  addFact('Serial', m.info ? String(m.info.serialNumber) : '—', !m.info);
  addFact('Supply', m.voltage != null ? `${m.voltage.toFixed(1)} V` : '—', m.voltage == null);
  addFact('Temperature', m.temperature != null ? `${m.temperature} °C` : 'below range', m.temperature == null);
  card.appendChild(facts);

  // ── status chips
  const chips = el('div', 'chips');
  if (m.status) {
    if (m.status.fatalErrorCode) {
      const info = errorCodes?.get(m.status.fatalErrorCode);
      const chip = el('span', 'tag tag-err', `fatal ${m.status.fatalErrorCode}${info ? ` · ${info.short_desc || info.enum}` : ''}`);
      if (info) chip.title = info.long_desc;
      chips.appendChild(chip);
    } else {
      chips.appendChild(el('span', 'tag tag-ok', 'healthy'));
    }
    for (const b of STATUS_BITS) {
      if (b.key === 'inBootloader' || !m.status[b.key]) continue;
      chips.appendChild(el('span', 'tag tag-info', b.label.toLowerCase()));
    }
    if (m.status.inBootloader) chips.appendChild(el('span', 'tag tag-warn', 'in bootloader'));
  } else {
    chips.appendChild(el('span', 'tag tag-mute', 'not read'));
  }
  if (m.aliveTest) {
    chips.appendChild(el('span', `tag ${m.aliveTest.passed ? 'tag-ok' : 'tag-err'}`,
      m.aliveTest.passed
        ? `alive · ${m.aliveTest.achieved.toFixed(3)} rev`
        : `test failed · ${m.aliveTest.achieved.toFixed(3)} rev`));
  }
  card.appendChild(chips);

  // ── status line
  if (m.busy) {
    const s = el('div', 'card-status is-busy');
    s.appendChild(el('div', 'spinner'));
    s.appendChild(el('span', null, m.busyLabel || 'Working…'));
    card.appendChild(s);
  } else if (m.error) {
    card.appendChild(el('div', 'card-status is-err', m.error));
  }

  // ── actions
  const actions = el('div', 'card-actions');
  for (const a of motorActions(m, true)) actions.appendChild(a);
  card.appendChild(actions);

  applyAck(card, m.key);
  return card;
}

/** The four per-motor commands, identical in both views. */
function motorActions(m, withLabels) {
  // Only an absent motor greys its controls. A busy one keeps its buttons looking
  // normal — the input lock swallows clicks while a command is in flight, so
  // nothing can be sent, and 35 rows flickering grey for a few hundred
  // milliseconds is far more distracting than a click that quietly does nothing.
  const mk = (cmd, title, label, cls, onclick) =>
    actionBtn({ cmd, title, label: withLabels ? label : null, cls, onclick, disabled: !m.present });

  return [
    mk('identify', 'Identify — flashes the green LED', 'Identify', '',
      () => runAction(m, 'identify', () => fleet.identify(m))),
    mk('alive', 'Alive test — spins one revolution', 'Alive test', withLabels ? 'btn-accent' : 'is-accent',
      () => runAction(m, 'alive', () => fleet.aliveTest(m), (r) => ({
        kind: r.passed ? 'ok' : 'err',
        text: r.passed
          ? `${aliasLabel(m)} turned ${r.achieved.toFixed(3)} revolutions — within ${r.errorPct.toFixed(2)}% of target.`
          : `${aliasLabel(m)} only reached ${r.achieved.toFixed(3)} revolutions (fatal error ${r.fatalErrorCode}).`,
      }))),
    mk('alias', 'Set alias', 'Set alias', '', () => promptAlias(m)),
    mk('firmware', 'Choose firmware — any compatible build, newer or older',
      'Firmware', '', () => chooseFirmware(m)),
    mk('reset', 'Reset', 'Reset', withLabels ? 'btn-ghost' : '',
      () => runAction(m, 'reset', (ackNow) => fleet.reset(m, { onAck: ackNow }))),
  ];
}

// ─────────────────────────────────────────────────────── chrome
function showProgress(label, value, max) {
  $('progress').hidden = false;
  $('progressLabel').textContent = label;
  $('progressCount').textContent = max > 1 ? `${value} / ${max}` : '';
  // max === 0 means "working, duration unknown" — show a moving stripe.
  $('progressBar').classList.toggle('is-indeterminate', max === 0);
  $('progressBar').style.width = max ? `${(value / max) * 100}%` : '100%';
}
const hideProgress = () => { $('progress').hidden = true; };

function banner(kind, html) {
  const b = $('banner');
  b.hidden = false;
  b.className = `banner banner-${kind}`;
  b.innerHTML = html;
}
const clearBanner = () => { $('banner').hidden = true; };

function setBusyButtons(busy) {
  for (const id of ['scanBtn', 'scanBtn2', 'fixAliasBtn', 'rescanInfoBtn']) $(id).disabled = busy;
}

/**
 * Show a modal and resolve true when it was dismissed with the ok button.
 *
 * Resolves on whichever of submit / cancel / close arrives first. Waiting on
 * `close` alone is not dependable — it does not fire here even for a freshly
 * created dialog, which left every dialog-driven flow hanging forever. `submit`
 * carries the submitter, so it answers the question on its own; the frame delay
 * lets the dialog finish closing before the caller opens another one.
 */
function openDialog(dlg) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      dlg.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('close', onClose);
      dlg.removeEventListener('cancel', onCancel);
      resolve(value);
    };
    const onSubmit = (e) => {
      const ok = e.submitter?.value === 'ok';
      // A timer, not requestAnimationFrame: rAF never runs in a background tab,
      // which would leave the caller awaiting this promise forever.
      setTimeout(() => finish(ok), 0);
    };
    const onClose = () => finish(dlg.returnValue === 'ok');
    const onCancel = () => finish(false);   // Escape
    dlg.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
  });
}

async function promptNumber(title, sub, min, max) {
  $('aliasDialogSub').textContent = sub;
  const input = $('aliasInput');
  input.value = '';
  input.min = min;
  input.max = max;
  const ok = await openDialog($('aliasDialog'));
  if (!ok) return null;
  const v = Number(input.value);
  return Number.isInteger(v) && v >= min && v <= max ? v : null;
}

function confirmDialog(title, bodyHtml, { okLabel = 'Continue', cancelLabel = 'Cancel' } = {}) {
  $('confirmTitle').textContent = title;
  $('confirmBody').innerHTML = bodyHtml;
  $('confirmOk').textContent = okLabel;
  // A null cancel label makes this an acknowledgement rather than a choice.
  const cancel = $('confirmDialog').querySelector('[value="cancel"]');
  cancel.hidden = cancelLabel == null;
  if (cancelLabel != null) cancel.textContent = cancelLabel;
  return openDialog($('confirmDialog'));
}

async function promptAlias(motor) {
  $('aliasDialogSub').textContent = `${aliasLabel(motor)} · ${idHex(motor.uniqueId)}`;
  const input = $('aliasInput');
  input.min = 1;
  input.max = 251;
  input.value = motor.alias === 255 ? '' : motor.alias;
  if (!(await openDialog($('aliasDialog')))) return;
  const v = Number(input.value);
  if (!Number.isInteger(v)) return;
  runAction(motor, 'alias', () => fleet.setAlias(motor, v));
}
