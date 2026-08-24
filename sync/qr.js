// Dependency-free QR code encoder (ISO/IEC 18004-shaped: Reed-Solomon error
// correction, standard mask-pattern scoring, byte-mode encoding only).
//
// EXTRACTED, not newly written, for Phase 9 (cross-device real-time
// sessions): this exact implementation already existed inline inside
// devices/pacemaker/5392-pacemaker-simulator.html (its own `const QR =
// (function(){...})()` IIFE, built for that device's own dashboard<->learner
// relay pairing) - a real instance of this project's "check your own
// Claude Projects folders before reasoning from scratch" pattern, just
// found this time INSIDE this repo rather than a sibling one. Rather than
// writing a second QR generator for the Facilitator Console's new Cloud
// Session join flow, this module is that same code, byte-for-byte in logic,
// factored out as a shared ESM export.
//
// Deliberately left the pacemaker file's own inline copy UNTOUCHED (not
// migrated to import this) - that 2500-line file is a delicate, real-hardware
// -matching classic (non-module) <script>, and swapping its working QR
// implementation for an import is pure risk with zero behavior change to
// show for it. Minor duplication, explicitly accepted, not a silent gap -
// see CLAUDE.md's Phase 9 section.
//
// Usage: `import { renderToCanvas } from '../sync/qr.js'; renderToCanvas(canvasEl, someUrl);`

const RS_BLOCK_TABLE = [
[[1,26,19],[1,26,16],[1,26,13],[1,26,9]],
[[1,44,34],[1,44,28],[1,44,22],[1,44,16]],
[[1,70,55],[1,70,44],[2,35,17],[2,35,13]],
[[1,100,80],[2,50,32],[2,50,24],[4,25,9]],
[[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12]],
[[2,86,68],[4,43,27],[4,43,19],[4,43,15]],
[[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14]],
[[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15]],
[[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13]],
[[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16]],
[[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13]],
[[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15]],
[[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12]],
[[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13]],
[[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13]],
[[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16]],
[[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15]],
[[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15]],
[[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14]],
[[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16]],
[[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17]],
[[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13]],
[[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16]],
[[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17]],
[[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16]],
[[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17]],
[[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16]],
[[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16]],
[[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16]],
[[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16]],
[[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16]],
[[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16]],
[[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16]],
[[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17]],
[[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16]],
[[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16]],
[[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16]],
[[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16]],
[[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16]],
[[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],
];
const PATTERN_POSITION_TABLE = [
[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],
[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],
[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],
[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],
[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],
[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],
[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170],
];
const G15 = 0b10100110111, G18 = 0b1111100100101, G15_MASK = 0b101010000010010;
const PAD0 = 0xEC, PAD1 = 0x11;
const LVL_ROW = { L: 0, M: 1, Q: 2, H: 3 };   // RS_BLOCK_TABLE row order (matches source table layout)
const LVL_BITS = { L: 1, M: 0, Q: 3, H: 2 };  // ISO 18004 format-info EC-level codes - a DIFFERENT numbering, do not conflate

const EXP = new Array(256), LOG = new Array(256);
for (let i = 0; i < 8; i++) EXP[i] = 1 << i;
for (let i = 8; i < 256; i++) EXP[i] = EXP[i - 4] ^ EXP[i - 5] ^ EXP[i - 6] ^ EXP[i - 8];
for (let i = 0; i < 255; i++) LOG[EXP[i]] = i;
function gexp(n) { n %= 255; if (n < 0) n += 255; return EXP[n]; }
function glog(n) { return LOG[n]; }

function trimZeros(a) { let i = 0; while (i < a.length - 1 && a[i] === 0) i++; return a.slice(i); }
function polyMulByRoot(poly, root) {
  const factor = [1, gexp(root)];
  const num = new Array(poly.length + 1).fill(0);
  for (let i = 0; i < poly.length; i++) for (let j = 0; j < 2; j++) num[i + j] ^= gexp(glog(poly[i]) + glog(factor[j]));
  return trimZeros(num);
}
function rsGeneratorPoly(ecCount) { let poly = [1]; for (let i = 0; i < ecCount; i++) poly = polyMulByRoot(poly, i); return poly; }
function polyMod(a, b) {
  a = trimZeros(a.slice());
  while (a.length - b.length >= 0) {
    const ratio = glog(a[0]) - glog(b[0]);
    for (let i = 0; i < b.length; i++) a[i] ^= gexp(glog(b[i]) + ratio);
    a = trimZeros(a);
  }
  return a;
}

function rsBlocksFor(version, rowLvl) {
  const row = RS_BLOCK_TABLE[version - 1][rowLvl], blocks = [];
  for (let i = 0; i < row.length; i += 3) {
    const count = row[i], total = row[i + 1], data = row[i + 2];
    for (let k = 0; k < count; k++) blocks.push({ total, data });
  }
  return blocks;
}
function charCountBits(version) { return version < 10 ? 8 : 16; }
function findVersion(byteLen, rowLvl) {
  let assumed = 8;
  for (let pass = 0; pass < 2; pass++) {
    const needed = 4 + assumed + 8 * byteLen;
    for (let v = 1; v <= 40; v++) {
      const blocks = rsBlocksFor(v, rowLvl);
      const bits = blocks.reduce((s, b) => s + b.data * 8, 0);
      if (bits >= needed) {
        const actual = charCountBits(v);
        if (actual === assumed) return v;
        assumed = actual; break;
      }
      if (v === 40) return null;
    }
  }
  return null;
}

function makeBuffer() {
  return {
    bytes: [], len: 0,
    put(num, length) { for (let i = length - 1; i >= 0; i--) this.putBit(((num >> i) & 1) === 1); },
    putBit(bit) {
      const idx = (this.len / 8) | 0; if (this.bytes.length <= idx) this.bytes.push(0);
      if (bit) this.bytes[idx] |= (0x80 >> (this.len % 8)); this.len++;
    }
  };
}
function createBytes(buffer, blocks) {
  let offset = 0, maxDc = 0, maxEc = 0; const dcdata = [], ecdata = [];
  for (const block of blocks) {
    const dcCount = block.data, ecCount = block.total - block.data;
    maxDc = Math.max(maxDc, dcCount); maxEc = Math.max(maxEc, ecCount);
    const dc = []; for (let i = 0; i < dcCount; i++) dc.push(buffer.bytes[i + offset] & 0xFF);
    offset += dcCount;
    const rsPoly = rsGeneratorPoly(ecCount);
    const raw = dc.concat(new Array(rsPoly.length - 1).fill(0));
    const mod = polyMod(raw, rsPoly);
    const ec = []; const modOffset = mod.length - ecCount;
    for (let i = 0; i < ecCount; i++) { const idx = i + modOffset; ec.push(idx >= 0 ? mod[idx] : 0); }
    dcdata.push(dc); ecdata.push(ec);
  }
  const data = [];
  for (let i = 0; i < maxDc; i++) for (const dc of dcdata) if (i < dc.length) data.push(dc[i]);
  for (let i = 0; i < maxEc; i++) for (const ec of ecdata) if (i < ec.length) data.push(ec[i]);
  return data;
}
function encodeData(version, rowLvl, bytes) {
  const buf = makeBuffer();
  buf.put(4, 4);
  buf.put(bytes.length, charCountBits(version));
  for (const b of bytes) buf.put(b, 8);
  const blocks = rsBlocksFor(version, rowLvl);
  const bitLimit = blocks.reduce((s, b) => s + b.data * 8, 0);
  for (let i = 0; i < Math.min(bitLimit - buf.len, 4); i++) buf.putBit(false);
  while (buf.len % 8) buf.putBit(false);
  let i = 0; while (buf.len < bitLimit) { buf.put(i % 2 === 0 ? PAD0 : PAD1, 8); i++; }
  return createBytes(buf, blocks);
}

function bchDigit(data) { let n = 0; while (data !== 0) { n++; data = Math.floor(data / 2); } return n; }
function bchTypeInfo(data) {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}
function bchTypeNumber(data) {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}
function maskFunc(pattern) {
  switch (pattern) {
    case 0: return (i, j) => (i + j) % 2 === 0;
    case 1: return (i, j) => i % 2 === 0;
    case 2: return (i, j) => j % 3 === 0;
    case 3: return (i, j) => (i + j) % 3 === 0;
    case 4: return (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return (i, j) => (i * j) % 2 + (i * j) % 3 === 0;
    case 6: return (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0;
    case 7: return (i, j) => ((i * j) % 3 + (i + j) % 2) % 2 === 0;
  }
}
function buildMatrix(version, ecLevelBits, dataCodewords, maskPattern) {
  const n = version * 4 + 17;
  const m = Array.from({ length: n }, () => new Array(n).fill(null));
  function setProbe(row, col) {
    for (let r = -1; r <= 7; r++) {
      if (row + r <= -1 || n <= row + r) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c <= -1 || n <= col + c) continue;
        if ((r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
          m[row + r][col + c] = true;
        else m[row + r][col + c] = false;
      }
    }
  }
  setProbe(0, 0); setProbe(n - 7, 0); setProbe(0, n - 7);
  const pos = PATTERN_POSITION_TABLE[version - 1];
  for (const row of pos) for (const col of pos) {
    if (m[row][col] !== null) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
      if (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) m[row + r][col + c] = true;
      else m[row + r][col + c] = false;
    }
  }
  for (let r = 8; r < n - 8; r++) if (m[r][6] === null) m[r][6] = (r % 2 === 0);
  for (let c = 8; c < n - 8; c++) if (m[6][c] === null) m[6][c] = (c % 2 === 0);

  const typeData = (ecLevelBits << 3) | maskPattern;
  const bits = bchTypeInfo(typeData);
  for (let i = 0; i < 15; i++) {
    const mod = ((bits >> i) & 1) === 1;
    if (i < 6) m[i][8] = mod;
    else if (i < 8) m[i + 1][8] = mod;
    else m[n - 15 + i][8] = mod;
  }
  for (let i = 0; i < 15; i++) {
    const mod = ((bits >> i) & 1) === 1;
    if (i < 8) m[8][n - i - 1] = mod;
    else if (i < 9) m[8][15 - i - 1 + 1] = mod;
    else m[8][15 - i - 1] = mod;
  }
  m[n - 8][8] = true;
  if (version >= 7) {
    const vbits = bchTypeNumber(version);
    for (let i = 0; i < 18; i++) {
      const mod = ((vbits >> i) & 1) === 1;
      m[Math.floor(i / 3)][i % 3 + n - 8 - 3] = mod;
      m[i % 3 + n - 8 - 3][Math.floor(i / 3)] = mod;
    }
  }
  const maskFn = maskFunc(maskPattern);
  let inc = -1, row = n - 1, bitIndex = 7, byteIndex = 0;
  const dataLen = dataCodewords.length;
  for (let colBase = n - 1; colBase > 0; colBase -= 2) {
    let col = colBase;
    if (col <= 6) col--;
    const colRange = [col, col - 1];
    while (true) {
      for (const c of colRange) {
        if (m[row][c] === null) {
          let dark = false;
          if (byteIndex < dataLen) dark = ((dataCodewords[byteIndex] >> bitIndex) & 1) === 1;
          if (maskFn(row, c)) dark = !dark;
          m[row][c] = dark;
          bitIndex--;
          if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
        }
      }
      row += inc;
      if (row < 0 || n <= row) { row -= inc; inc = -inc; break; }
    }
  }
  return m;
}

function rule1(m, n) {
  let total = 0; const container = new Array(n + 1).fill(0);
  for (let row = 0; row < n; row++) {
    const thisRow = m[row]; let prev = thisRow[0], length = 0;
    for (let col = 0; col < n; col++) {
      if (thisRow[col] === prev) length++;
      else { if (length >= 5) container[length]++; length = 1; prev = thisRow[col]; }
    }
    if (length >= 5) container[length]++;
  }
  for (let col = 0; col < n; col++) {
    let prev = m[0][col], length = 0;
    for (let row = 0; row < n; row++) {
      if (m[row][col] === prev) length++;
      else { if (length >= 5) container[length]++; length = 1; prev = m[row][col]; }
    }
    if (length >= 5) container[length]++;
  }
  for (let len = 5; len <= n; len++) total += container[len] * (len - 2);
  return total;
}
function rule2(m, n) {
  let total = 0;
  for (let row = 0; row < n - 1; row++) for (let col = 0; col < n - 1; col++) {
    const c = m[row][col];
    if (c === m[row][col + 1] && c === m[row + 1][col] && c === m[row + 1][col + 1]) total += 3;
  }
  return total;
}
function rule3(m, n) {
  let total = 0;
  for (let row = 0; row < n; row++) {
    const r = m[row];
    for (let col = 0; col + 10 < n; col++) {
      if (!r[col + 1] && r[col + 4] && !r[col + 5] && r[col + 6] && !r[col + 9] &&
        ((r[col + 0] && r[col + 2] && r[col + 3] && !r[col + 7] && !r[col + 8] && !r[col + 10]) ||
          (!r[col + 0] && !r[col + 2] && !r[col + 3] && r[col + 7] && r[col + 8] && r[col + 10]))) total += 40;
    }
  }
  for (let col = 0; col < n; col++) {
    for (let row = 0; row + 10 < n; row++) {
      if (!m[row + 1][col] && m[row + 4][col] && !m[row + 5][col] && m[row + 6][col] && !m[row + 9][col] &&
        ((m[row + 0][col] && m[row + 2][col] && m[row + 3][col] && !m[row + 7][col] && !m[row + 8][col] && !m[row + 10][col]) ||
          (!m[row + 0][col] && !m[row + 2][col] && !m[row + 3][col] && m[row + 7][col] && m[row + 8][col] && m[row + 10][col]))) total += 40;
    }
  }
  return total;
}
function rule4(m, n) {
  let dark = 0;
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) if (m[row][col]) dark++;
  const percent = dark / (n * n) * 100;
  return Math.floor(Math.abs(percent - 50) / 5) * 10;
}
function lostPoint(m) { const n = m.length; return rule1(m, n) + rule2(m, n) + rule3(m, n) + rule4(m, n); }

/** Encode `text` into a QR bit-matrix (2D array of booleans). Returns null if it doesn't fit any version. */
export function encode(text, levelName) {
  levelName = levelName || 'M';
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = findVersion(bytes.length, LVL_ROW[levelName]);
  if (version == null) { levelName = 'L'; version = findVersion(bytes.length, LVL_ROW.L); }
  if (version == null) return null;
  const dataCodewords = encodeData(version, LVL_ROW[levelName], bytes);
  let best = null, bestScore = Infinity;
  for (let mp = 0; mp < 8; mp++) {
    const matrix = buildMatrix(version, LVL_BITS[levelName], dataCodewords, mp);
    const score = lostPoint(matrix);
    if (score < bestScore) { bestScore = score; best = matrix; }
  }
  return best;
}

/** Render `text` as a QR code onto an existing <canvas> element. Returns false if the text doesn't fit. */
export function renderToCanvas(canvasEl, text, opts) {
  opts = opts || {};
  const cellPx = opts.cell || 4, quiet = opts.quiet == null ? 4 : opts.quiet;
  const matrix = encode(text, opts.level || 'M');
  if (!matrix) return false;
  const n = matrix.length, size = (n + quiet * 2) * cellPx;
  canvasEl.width = size; canvasEl.height = size;
  const ctx = canvasEl.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++)
    if (matrix[row][col]) ctx.fillRect((col + quiet) * cellPx, (row + quiet) * cellPx, cellPx, cellPx);
  return true;
}
