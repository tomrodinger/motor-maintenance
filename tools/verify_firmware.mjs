import { readFileSync } from 'fs';
import { parseFirmwareFile } from '../docs/js/firmware.js';
import { crc32 } from '../docs/js/protocol.js';
const ref = JSON.parse(readFileSync('./fw_ref.json','utf8'));
const bytes = new Uint8Array(readFileSync('../research/servomotor_repo/firmware/firmware_releases/servomotor_M17_fw0.15.9.0_scc3_hw1.5.firmware'));
const p = parseFirmwareFile(bytes);
const checks = [
  ['modelName', p.modelName, 'M17'],
  ['scc', p.compatibilityCode, ref.scc],
  ['imageCrc', p.imageCrc, ref.crc],
  ['payloadLen', p.payload.length, ref.payloadLen],
  ['pages', p.pages, ref.pages],
  ['crc(page0)', crc32(p.payload.subarray(0,2048)), ref.sha_first_page],
  ['crc(all)', crc32(p.payload), ref.sha_all],
];
let bad=0;
for (const [k,got,want] of checks){ const ok = got===want; if(!ok) bad++; console.log(`${ok?'ok  ':'FAIL'} ${k}: ${got}${ok?'':' != '+want}`); }
console.log(bad? `\n${bad} MISMATCH` : '\nFIRMWARE TRANSFORM MATCHES upgrade_firmware.py EXACTLY');
process.exit(bad?1:0);
