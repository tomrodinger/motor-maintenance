import { readFileSync } from 'fs';
import { encodePacket, crc32, ResponseFramer, concat } from '../docs/js/protocol.js';

const v = JSON.parse(readFileSync('./vectors.json', 'utf8'));
const hexOf = (b) => Buffer.from(b).toString('hex');
let fail = 0;

// CRC32
const crcCases = [[new Uint8Array(0)], [new TextEncoder().encode('123456789')], [Uint8Array.from({length:256},(_,i)=>i)]];
crcCases.forEach(([bytes], i) => {
  const got = crc32(bytes);
  if (got !== v.crc[i]) { console.log(`CRC FAIL ${i}: ${got} vs ${v.crc[i]}`); fail++; }
});
console.log(`crc32: ${crcCases.length - fail}/${crcCases.length} match zlib`);

// Packets
let pf = 0;
for (const c of v.packets) {
  const addr = BigInt(c.addr) > 255n ? BigInt(c.addr) : Number(c.addr);
  const payload = Uint8Array.from(Buffer.from(c.payload, 'hex'));
  const got = hexOf(encodePacket(addr, c.cmd, payload, true));
  if (got !== c.packet) { console.log(`PKT FAIL cmd=${c.cmd} addr=${c.addr}\n  js: ${got.slice(0,80)}\n  py: ${c.packet.slice(0,80)}`); pf++; }
}
console.log(`packets: ${v.packets.length - pf}/${v.packets.length} byte-identical to Python`);
fail += pf;

// Framer round-trip: build a response the way the device would, parse it back.
function buildResponse(payloadWithErr, crcEnabled = true) {
  const content = concat(Uint8Array.of(crcEnabled ? 253 : 252), payloadWithErr);
  let size = 1 + content.length + (crcEnabled ? 4 : 0);
  let head;
  if (size > 127) { size += 2; head = new Uint8Array(3); head[0] = 0xFF; new DataView(head.buffer).setUint16(1, size, true); }
  else head = Uint8Array.of((size << 1) | 1);
  let pkt = concat(head, content);
  if (crcEnabled) { const t = new Uint8Array(4); new DataView(t.buffer).setUint32(0, crc32(pkt), true); pkt = concat(pkt, t); }
  return pkt;
}

// detect-devices style: error byte 0 + u64 id + alias
const body = concat(Uint8Array.of(0), Uint8Array.from(Buffer.from('8877665544332211','hex')), Uint8Array.of(42));
const f = new ResponseFramer();
const wire = concat(buildResponse(body), buildResponse(new Uint8Array(0)), buildResponse(concat(Uint8Array.of(0), new Uint8Array(300))));
// feed byte-by-byte to prove it handles arbitrary chunking
const frames = [];
for (const b of wire) { f.push(Uint8Array.of(b)); let fr; while ((fr = f.next())) frames.push(fr); }
console.log(`framer: ${frames.length} frames from byte-at-a-time stream (expect 3)`);
if (frames.length !== 3) fail++;
if (hexOf(frames[0].payload) !== '887766554433221' + '12a') { console.log('  payload:', hexOf(frames[0].payload)); }
if (frames[1].payload.length !== 0) { console.log('  ack frame not empty'); fail++; }
if (frames[2].payload.length !== 300) { console.log('  extended-size payload len', frames[2].payload.length); fail++; }

// A frame with a corrupted CRC must never be surfaced as valid.
const bad = buildResponse(body); bad[bad.length - 1] ^= 0xFF;
const f2 = new ResponseFramer(); f2.push(bad);
if (f2.next() !== null) { console.log('CRC corruption NOT detected'); fail++; }
else console.log(`crc check: corrupted frame rejected (${f2.droppedBytes} bytes discarded)`);

// Regression for the bug found on the 35-motor rack: a burst of Detect devices
// replies with corruption in the middle. Every intact frame must still come out.
// The old consume-then-validate framer returned 1 of 5 here.
const reply = (n) => buildResponse(concat(
  Uint8Array.of(0), Uint8Array.from(Buffer.from(`00000000000000${n.toString(16).padStart(2,'0')}`, 'hex')), Uint8Array.of(88)));
const clean = [1, 2, 3, 4, 5].map(reply);
const corrupt = reply(9);
corrupt[0] = 0x7F;            // plausible LSB-set size byte claiming 63 bytes
const burst = concat(clean[0], clean[1], corrupt, clean[2], clean[3], clean[4]);
const f3 = new ResponseFramer();
const got = [];
for (const b of burst) { f3.push(Uint8Array.of(b)); let fr; while ((fr = f3.next())) got.push(fr); }
const ok3 = got.length === 5;
console.log(`resync: recovered ${got.length}/5 intact frames around a corrupt one` +
            ` (${f3.droppedBytes} bytes discarded)${ok3 ? '' : '  <-- FAIL'}`);
if (!ok3) fail++;

// And the same burst delivered as one big chunk, the way a USB transfer arrives.
const f4 = new ResponseFramer(); f4.push(burst);
const got4 = []; { let fr; while ((fr = f4.next())) got4.push(fr); }
const ok4 = got4.length === 5;
console.log(`resync: recovered ${got4.length}/5 from a single coalesced chunk${ok4 ? '' : '  <-- FAIL'}`);
if (!ok4) fail++;

console.log(fail === 0 ? '\nALL PROTOCOL TESTS PASS' : `\n${fail} FAILURES`);
process.exit(fail ? 1 : 0);
