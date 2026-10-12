// vgpu_core.js - Cloudflare Workers / Node / 브라우저에서 동작하는 가상 GPU 코어 (의존성 없음)
//
// 설계 (Python 기준 구현 vgpu.py와 같은 ISA/어셈블리 문법):
//  1) 배리어 위상 실행(barrier-phase): 스레드를 BAR/EXIT까지 순차 실행 -> V8 JIT에 최적, 블록 내 배리어는 정확.
//     SHFL/VOTE 같은 워프 동기 명령이 있으면 자동으로 워프 락스텝(전역 최소 PC) 스케줄러 사용.
//  2) 낙관적 샤딩(optimistic sharding) + 검증 + 직렬 폴백:
//     블록 범위를 여러 Worker(샤드)에 나눠 실행하고, 각 샤드는 메모리 '델타'와 '원자연산 집계'만 반환.
//     병합은 가환 연산(ADD/MIN/MAX/AND/OR/XOR)의 집계로 정확히 수행하고,
//     (a) 서로 다른 값의 동일 주소 쓰기 (b) 다른 샤드가 쓴 주소를 먼저 읽은 경우 (c) 비가환 원자연산(EXCH/CAS)
//     이 발견되면 샤딩이 부적합하다고 판정해 단일 샤드 직렬 실행으로 자동 폴백한다.

export const WARP = 32, NREG = 64, NPRED = 8;

const OPS = ['MOV', 'IADD', 'ISUB', 'IMUL', 'IMIN', 'IMAX', 'AND', 'OR', 'XOR', 'IDIV', 'IMOD', 'SHL', 'SHR', 'SAR',
  'FADD', 'FSUB', 'FMUL', 'FDIV', 'FMIN', 'FMAX', 'FFMA', 'FSQRT', 'FRSQ', 'FSIN', 'FCOS', 'FEX2', 'FLG2', 'FABS',
  'FNEG', 'FFLOOR', 'I2F', 'F2I', 'ISETP', 'FSETP', 'SEL', 'PAND', 'POR', 'PNOT', 'LD', 'ST', 'LDS', 'STS', 'LDL',
  'STL', 'LDC', 'ATOM', 'S2R', 'PARAM', 'BRA', 'BAR', 'EXIT', 'NOP', 'SHFL', 'VOTE', 'TEX'];
const OP = Object.fromEntries(OPS.map((n, i) => [n, i]));
const CMP = { LT: 0, LE: 1, GT: 2, GE: 3, EQ: 4, NE: 5 };
const SPEC = { tid: 0, ctaid: 1, ntid: 2, nctaid: 3, laneid: 4 };
export const ATOM_SUB = { ADD: 0, FADD: 1, MIN: 2, MAX: 3, AND: 4, OR: 5, XOR: 6, EXCH: 7, CAS: 8 };
const SHFL = { UP: 0, DOWN: 1, XOR: 2, IDX: 3 };
const VOTE = { BALLOT: 0, ANY: 1, ALL: 2 };
// 오퍼랜드 종류
const K_REG = 0, K_INT = 1, K_FLT = 2, K_PRED = 3, K_MEM = 4, K_SPEC = 5;

const sf = new Float32Array(1), su = new Uint32Array(sf.buffer);
const f2u = x => { sf[0] = x; return su[0]; };
const u2f = x => { su[0] = x; return sf[0]; };

function parseOperand(a) {
  let m;
  if ((m = /^r(\d+)$/i.exec(a))) {
    if (+m[1] >= NREG) throw new Error(`register out of range: ${a}`);
    return { k: K_REG, v: +m[1] };
  }
  if ((m = /^p(\d+)$/i.exec(a))) return { k: K_PRED, v: +m[1] };
  if (a.startsWith('#')) {
    const s = a.slice(1);
    if (/[.eE]/.test(s) && !/^-?0x/i.test(s)) return { k: K_FLT, f: parseFloat(s), v: 0 };
    const neg = s.startsWith('-');
    const n = Number(neg ? s.slice(1) : s);
    if (Number.isNaN(n)) throw new Error(`bad immediate ${a}`);
    return { k: K_INT, v: (neg ? -n : n) | 0 };
  }
  if ((m = /^\[\s*r(\d+)\s*(?:([+-])\s*(\w+))?\s*\]$/i.exec(a))) {
    let off = m[3] ? Number(m[3]) : 0;
    if (m[2] === '-') off = -off;
    return { k: K_MEM, v: +m[1], off };
  }
  if ((m = /^(tid|ctaid|ntid|nctaid)\.([xyz])$/i.exec(a))) return { k: K_SPEC, v: SPEC[m[1].toLowerCase()], ax: 'xyz'.indexOf(m[2].toLowerCase()) };
  if (a.toLowerCase() === 'laneid') return { k: K_SPEC, v: SPEC.laneid, ax: 0 };
  if (/^[-+]?(0x[0-9a-f]+|\d+)$/i.test(a)) return { k: K_INT, v: Number(a) | 0 };
  return { k: -1, label: a };
}

export function assemble(src) {
  const lines = [], labels = new Map();
  for (const raw of src.split('\n')) {
    let line = raw.split(';')[0].split('//')[0].trim();
    let m;
    while ((m = /^([A-Za-z_]\w*):\s*(.*)$/.exec(line))) { labels.set(m[1], lines.length); line = m[2].trim(); }
    if (line) lines.push(line);
  }
  const ins = [];
  for (const text of lines) {
    let line = text, guard = -1, neg = 0, g;
    if ((g = /^@(!?)p(\d+)\s+(.*)$/i.exec(line))) { neg = g[1] ? 1 : 0; guard = +g[2]; line = g[3]; }
    const sp = line.search(/\s/);
    const opfull = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp < 0 ? '' : line.slice(sp + 1);
    const dot = opfull.indexOf('.');
    const op = dot < 0 ? opfull : opfull.slice(0, dot), sub = dot < 0 ? '' : opfull.slice(dot + 1);
    if (!(op in OP)) throw new Error(`unknown opcode '${op}' in: ${text}`);
    const args = rest.split(',').map(s => s.trim()).filter(Boolean).map(parseOperand);
    ins.push({ op: OP[op], opName: op, sub, guard, neg, args, text });
  }
  ins.push({ op: OP.EXIT, opName: 'EXIT', sub: '', guard: -1, neg: 0, args: [], text: '(implicit)' });
  const n = ins.length;
  const P = {
    n, OP: new Int32Array(n), SUB: new Int32Array(n), GD: new Int32Array(n), NG: new Uint8Array(n),
    A0: new Int32Array(n), A1: new Int32Array(n), A2: new Int32Array(n), A3: new Int32Array(n), MO: new Int32Array(n),
    text: ins.map(i => i.text), needsLockstep: false, hasAtomic: false, atomicDead: true,
  };
  // 즉시값은 스레드 레지스터 파일의 상수 슬롯(NREG 이후)에 두어 모든 소스를 분기 없는 레지스터 읽기로 통일
  const immSlot = new Map(), immBits = [];
  const slotFor = (bits) => {
    if (!immSlot.has(bits)) { immSlot.set(bits, NREG + immBits.length); immBits.push(bits >>> 0); }
    return immSlot.get(bits);
  };
  const CLS = (it) => {
    const nm = it.opName;
    if (nm === 'MOV') return 'du';
    if (['IADD', 'ISUB', 'IMUL', 'IMIN', 'IMAX', 'IDIV', 'IMOD'].includes(nm)) return 'dii';
    if (['AND', 'OR', 'XOR', 'SHL', 'SHR', 'SAR'].includes(nm)) return 'duu';
    if (['FADD', 'FSUB', 'FMUL', 'FDIV', 'FMIN', 'FMAX'].includes(nm)) return 'dff';
    if (nm === 'FFMA') return 'dfff';
    if (['FSQRT', 'FRSQ', 'FSIN', 'FCOS', 'FEX2', 'FLG2', 'FABS', 'FNEG', 'FFLOOR', 'F2I'].includes(nm)) return 'df';
    if (nm === 'I2F') return 'di';
    if (nm === 'ISETP') return 'pii';
    if (nm === 'FSETP') return 'pff';
    if (nm === 'SEL') return 'dpuu';
    if (nm === 'PAND' || nm === 'POR') return 'ppp';
    if (nm === 'PNOT') return 'pp';
    if (['LD', 'LDS', 'LDL', 'LDC'].includes(nm)) return 'dm';
    if (['ST', 'STS', 'STL'].includes(nm)) return 'mu';
    if (nm === 'ATOM') return 'dmuu';
    if (nm === 'S2R') return 'ds';
    if (nm === 'PARAM') return 'dn';
    if (nm === 'BRA') return 'n';
    if (nm === 'SHFL') return 'dri';
    if (nm === 'VOTE') return it.sub === 'BALLOT' ? 'dp' : 'pp';
    if (nm === 'TEX') return 'dnff';
    return '';
  };
  const slot = (a, c) => {
    if (!a) return 0;
    switch (c) {
      case 'd': case 'r': case 'p': case 'm': return a.v;
      case 's': return a.v * 4 + a.ax;
      case 'n': return a.v;
      case 'i': return a.k === K_REG ? a.v : slotFor(a.k === K_FLT ? Math.trunc(a.f) | 0 : a.v | 0);
      case 'f': return a.k === K_REG ? a.v : slotFor(f2u(a.k === K_FLT ? a.f : a.v));
      default: return a.k === K_REG ? a.v : slotFor(a.k === K_FLT ? f2u(a.f) : a.v >>> 0); // 'u'
    }
  };
  ins.forEach((it, i) => {
    P.OP[i] = it.op; P.GD[i] = it.guard; P.NG[i] = it.neg;
    if (it.op === OP.ISETP || it.op === OP.FSETP) {
      if (!(it.sub in CMP)) throw new Error(`bad compare '${it.sub}'`);
      P.SUB[i] = CMP[it.sub];
    } else if (it.op === OP.ATOM) {
      if (!(it.sub in ATOM_SUB)) throw new Error(`bad atomic '${it.sub}'`);
      P.SUB[i] = ATOM_SUB[it.sub]; P.hasAtomic = true;
    } else if (it.op === OP.SHFL) { P.SUB[i] = SHFL[it.sub]; P.needsLockstep = true; }
    else if (it.op === OP.VOTE) { P.SUB[i] = VOTE[it.sub]; P.needsLockstep = true; }
    const cls = CLS(it);
    it.args = it.args.map(a => {
      if (a.k === -1) {
        if (!labels.has(a.label)) throw new Error(`undefined label '${a.label}'`);
        return { k: K_INT, v: labels.get(a.label) };
      }
      return a;
    });
    const memArg = it.args.find(a => a.k === K_MEM);
    if (memArg) P.MO[i] = memArg.off;
    const out = [P.A0, P.A1, P.A2, P.A3];
    for (let j = 0; j < 4; j++) out[j][i] = slot(it.args[j], cls[j] || 'u');
  });
  P.NIMM = immBits.length; P.STRIDE = NREG + immBits.length; P.IMM = Uint32Array.from(immBits);
  // 원자연산 결과 레지스터가 이후 어디서도 읽히지 않는지(=샤딩 가능한지) 보수적으로 판정
  ins.forEach((it, i) => {
    if (it.op !== OP.ATOM) return;
    const d = it.args[0].v;
    ins.forEach((o, k) => {
      if (k === i) return;
      const srcStart = (o.op === OP.ST || o.op === OP.STS || o.op === OP.STL) ? 0 : 1;
      o.args.forEach((a, j) => {
        if (j >= srcStart && ((a.k === K_REG && a.v === d) || (a.k === K_MEM && a.v === d))) P.atomicDead = false;
      });
      if ((o.op === OP.ST || o.op === OP.STS || o.op === OP.STL) && o.args[0].k === K_MEM && o.args[0].v === d) P.atomicDead = false;
    });
  });
  return P;
}


export class VGPU {
  constructor({ memBytes = 16 << 20 } = {}) {
    this.size = memBytes;
    this.buf = new ArrayBuffer(memBytes);
    this.u32 = new Uint32Array(this.buf); this.i32 = new Int32Array(this.buf); this.f32 = new Float32Array(this.buf);
    this.top = 256; // 0..255 = NULL 보호
  }
  malloc(bytes) {
    const p = this.top;
    this.top = (this.top + Math.max(bytes, 4) + 255) & ~255;
    if (this.top > this.size) throw new Error('out of device memory');
    return p;
  }
  write(ptr, ta) { new Uint8Array(this.buf, ptr, ta.byteLength).set(new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength)); }
  read(ptr, Ctor, count) { return new Ctor(this.buf.slice(ptr, ptr + count * Ctor.BYTES_PER_ELEMENT)); }

  /** opts: {blocks:[lo,hi), sharedBytes, localBytes, constants:Uint32Array, lockstep, track} -> stats */
  launch(prog, grid, block, params = [], opts = {}) {
    if (typeof prog === 'string') prog = assemble(prog);
    grid = dim3(grid); block = dim3(block);
    const nt = block[0] * block[1] * block[2];
    if (nt < 1 || nt > 1024) throw new Error(`invalid block size ${nt} (1..1024)`);
    const nblocks = grid[0] * grid[1] * grid[2];
    const [lo, hi] = opts.blocks || [0, nblocks];
    const pk = new Uint32Array(Math.max(1, params.length));
    params.forEach((p, i) => { pk[i] = (typeof p === 'object' && p !== null) ? f2u(p.f) : (p | 0) >>> 0; });
    const track = opts.track ? {
      dirty: new Uint8Array(this.size >> 2), readFirst: new Uint8Array(this.size >> 2), atom: new Map(), noncomm: false,
    } : null;
    const run = makeRunner(this, prog, grid, block, pk, opts, track);
    const lockstep = opts.lockstep || prog.needsLockstep;
    for (let b = lo; b < hi; b++) {
      const bx = b % grid[0], by = Math.floor(b / grid[0]) % grid[1], bz = Math.floor(b / (grid[0] * grid[1]));
      lockstep ? run.blockLockstep(bx, by, bz) : run.blockPhased(bx, by, bz);
    }
    return { blocks: hi - lo, threads: (hi - lo) * nt, laneInstrs: run.stats.laneInstrs, track };
  }
}

function dim3(d) {
  if (typeof d === 'number') return [d, 1, 1];
  const a = [...d]; while (a.length < 3) a.push(1);
  return a.slice(0, 3);
}

function makeRunner(gpu, P, grid, block, params, opts, track) {
  const n = block[0] * block[1] * block[2];
  const S = P.STRIDE;
  const regs = new Uint32Array(n * S), ri = new Int32Array(regs.buffer), rf = new Float32Array(regs.buffer);
  const preds = new Uint8Array(n * NPRED);
  const pc = new Int32Array(n), status = new Uint8Array(n); // 0=실행, 1=배리어 대기, 2=종료
  const shared = new Uint32Array(Math.max(1, ((opts.sharedBytes || 0) + 3) >> 2));
  const lw = ((opts.localBytes || 0) + 3) >> 2;
  const localBytes = opts.localBytes || 0;
  const local = new Uint32Array(Math.max(1, n * lw));
  const cbank = opts.constants || new Uint32Array(1);
  const mu = gpu.u32, msize = gpu.size;
  const { OP: O, SUB, GD, NG, A0, A1, A2, A3, MO, IMM, NIMM } = P;
  const stats = { laneInstrs: 0 };
  let bx = 0, by = 0, bz = 0;
  const bdx = block[0], bdxy = block[0] * block[1];

  const fault = (t, i, msg) => { throw new Error(`block(${bx},${by},${bz}) thread ${t} pc=${i}: ${msg}   [${P.text[i]}]`); };
  const gaddr = (t, i, base, reg) => {
    const a = (regs[base + reg] + MO[i]) >>> 0;
    if ((a & 3) || a < 256 || a + 4 > msize) fault(t, i, `illegal global address 0x${a.toString(16)}`);
    return a >> 2;
  };

  // 한 명령 실행 -> 다음 pc (BAR/EXIT는 status 변경). 모든 소스는 레지스터 슬롯(즉시값 포함)이라 분기 없음.
  function step(t, i) {
    const base = t * S, d = base + A0[i];
    switch (O[i]) {
      case 0: regs[d] = regs[base + A1[i]]; break; // MOV
      case 1: ri[d] = (ri[base + A1[i]] + ri[base + A2[i]]) | 0; break;
      case 2: ri[d] = (ri[base + A1[i]] - ri[base + A2[i]]) | 0; break;
      case 3: ri[d] = Math.imul(ri[base + A1[i]], ri[base + A2[i]]); break;
      case 4: { const a = ri[base + A1[i]], b = ri[base + A2[i]]; ri[d] = a < b ? a : b; break; }
      case 5: { const a = ri[base + A1[i]], b = ri[base + A2[i]]; ri[d] = a > b ? a : b; break; }
      case 6: regs[d] = regs[base + A1[i]] & regs[base + A2[i]]; break;
      case 7: regs[d] = regs[base + A1[i]] | regs[base + A2[i]]; break;
      case 8: regs[d] = regs[base + A1[i]] ^ regs[base + A2[i]]; break;
      case 9: { const a = ri[base + A1[i]], b = ri[base + A2[i]]; ri[d] = b === 0 ? 0 : Math.trunc(a / b); break; }
      case 10: { const a = ri[base + A1[i]], b = ri[base + A2[i]]; ri[d] = b === 0 ? 0 : (a - Math.imul(Math.trunc(a / b), b)) | 0; break; }
      case 11: regs[d] = regs[base + A1[i]] << (regs[base + A2[i]] & 31); break;
      case 12: regs[d] = regs[base + A1[i]] >>> (regs[base + A2[i]] & 31); break;
      case 13: ri[d] = ri[base + A1[i]] >> (regs[base + A2[i]] & 31); break;
      case 14: rf[d] = rf[base + A1[i]] + rf[base + A2[i]]; break;
      case 15: rf[d] = rf[base + A1[i]] - rf[base + A2[i]]; break;
      case 16: rf[d] = rf[base + A1[i]] * rf[base + A2[i]]; break;
      case 17: rf[d] = rf[base + A1[i]] / rf[base + A2[i]]; break;
      case 18: rf[d] = Math.min(rf[base + A1[i]], rf[base + A2[i]]); break;
      case 19: rf[d] = Math.max(rf[base + A1[i]], rf[base + A2[i]]); break;
      case 20: rf[d] = Math.fround(Math.fround(rf[base + A1[i]] * rf[base + A2[i]]) + rf[base + A3[i]]); break; // FFMA
      case 21: rf[d] = Math.sqrt(rf[base + A1[i]]); break;
      case 22: rf[d] = 1 / Math.sqrt(rf[base + A1[i]]); break;
      case 23: rf[d] = Math.sin(rf[base + A1[i]]); break;
      case 24: rf[d] = Math.cos(rf[base + A1[i]]); break;
      case 25: rf[d] = Math.pow(2, rf[base + A1[i]]); break;
      case 26: rf[d] = Math.log2(rf[base + A1[i]]); break;
      case 27: rf[d] = Math.abs(rf[base + A1[i]]); break;
      case 28: rf[d] = -rf[base + A1[i]]; break;
      case 29: rf[d] = Math.floor(rf[base + A1[i]]); break;
      case 30: rf[d] = ri[base + A1[i]]; break; // I2F
      case 31: { const v = Math.trunc(rf[base + A1[i]]); ri[d] = v !== v ? 0 : (v > 2147483647 ? 2147483647 : v < -2147483648 ? -2147483648 : v); break; }
      case 32: { // ISETP
        const a = ri[base + A1[i]], b = ri[base + A2[i]];
        const r = SUB[i] === 0 ? a < b : SUB[i] === 1 ? a <= b : SUB[i] === 2 ? a > b : SUB[i] === 3 ? a >= b : SUB[i] === 4 ? a === b : a !== b;
        preds[t * NPRED + A0[i]] = r ? 1 : 0; break;
      }
      case 33: { // FSETP
        const a = rf[base + A1[i]], b = rf[base + A2[i]];
        const r = SUB[i] === 0 ? a < b : SUB[i] === 1 ? a <= b : SUB[i] === 2 ? a > b : SUB[i] === 3 ? a >= b : SUB[i] === 4 ? a === b : a !== b;
        preds[t * NPRED + A0[i]] = r ? 1 : 0; break;
      }
      case 34: regs[d] = preds[t * NPRED + A1[i]] ? regs[base + A2[i]] : regs[base + A3[i]]; break; // SEL
      case 35: preds[t * NPRED + A0[i]] = preds[t * NPRED + A1[i]] & preds[t * NPRED + A2[i]]; break;
      case 36: preds[t * NPRED + A0[i]] = preds[t * NPRED + A1[i]] | preds[t * NPRED + A2[i]]; break;
      case 37: preds[t * NPRED + A0[i]] = preds[t * NPRED + A1[i]] ^ 1; break;
      case 38: { // LD
        const w = gaddr(t, i, base, A1[i]);
        if (track && !track.dirty[w]) track.readFirst[w] = 1;
        regs[d] = mu[w]; break;
      }
      case 39: { // ST: A0=주소 레지스터, A1=값 슬롯
        const w = gaddr(t, i, base, A0[i]);
        if (track) { track.dirty[w] = 1; if (track.atom.has(w)) track.mixed = true; }
        mu[w] = regs[base + A1[i]]; break;
      }
      case 40: { // LDS
        const a = (regs[base + A1[i]] + MO[i]) | 0;
        if ((a & 3) || a < 0 || (a >> 2) >= shared.length) fault(t, i, 'illegal shared memory address');
        regs[d] = shared[a >> 2]; break;
      }
      case 41: { // STS
        const a = (regs[base + A0[i]] + MO[i]) | 0;
        if ((a & 3) || a < 0 || (a >> 2) >= shared.length) fault(t, i, 'illegal shared memory address');
        shared[a >> 2] = regs[base + A1[i]]; break;
      }
      case 42: { // LDL
        const a = (regs[base + A1[i]] + MO[i]) | 0;
        if ((a & 3) || a < 0 || a >= localBytes) fault(t, i, 'illegal local memory address (array index out of range)');
        regs[d] = local[t * lw + (a >> 2)]; break;
      }
      case 43: { // STL
        const a = (regs[base + A0[i]] + MO[i]) | 0;
        if ((a & 3) || a < 0 || a >= localBytes) fault(t, i, 'illegal local memory address (array index out of range)');
        local[t * lw + (a >> 2)] = regs[base + A1[i]]; break;
      }
      case 44: { // LDC
        const a = (regs[base + A1[i]] + MO[i]) | 0;
        if ((a & 3) || a < 0 || (a >> 2) >= cbank.length) fault(t, i, 'illegal constant memory address');
        regs[d] = cbank[a >> 2]; break;
      }
      case 45: { // ATOM: A1=주소 레지스터, A2=값(또는 CAS 비교값) 슬롯, A3=CAS 새 값 슬롯
        const w = gaddr(t, i, base, A1[i]);
        const old = mu[w], v = regs[base + A2[i]], sub = SUB[i];
        let nv;
        switch (sub) {
          case 0: nv = (old + v) >>> 0; break;
          case 1: nv = f2u(Math.fround(u2f(old) + u2f(v))); break;
          case 2: nv = (Math.min(old | 0, v | 0)) >>> 0; break;
          case 3: nv = (Math.max(old | 0, v | 0)) >>> 0; break;
          case 4: nv = (old & v) >>> 0; break;
          case 5: nv = (old | v) >>> 0; break;
          case 6: nv = (old ^ v) >>> 0; break;
          case 7: nv = v; break;
          default: nv = old === v ? regs[base + A3[i]] : old; // CAS
        }
        mu[w] = nv; regs[d] = old;
        if (track) {
          if (track.dirty[w]) track.mixed = true;
          if (sub >= 7) track.noncomm = true;
          const e = track.atom.get(w);
          if (!e) track.atom.set(w, { sub, acc: sub === 1 ? u2f(v) : v >>> 0 });
          else if (e.sub !== sub) track.noncomm = true;
          else switch (sub) {
            case 0: e.acc = (e.acc + v) >>> 0; break;
            case 1: e.acc += u2f(v); break;
            case 2: e.acc = Math.min(e.acc | 0, v | 0) >>> 0; break;
            case 3: e.acc = Math.max(e.acc | 0, v | 0) >>> 0; break;
            case 4: e.acc = (e.acc & v) >>> 0; break;
            case 5: e.acc = (e.acc | v) >>> 0; break;
            default: e.acc = (e.acc ^ v) >>> 0;
          }
        }
        break;
      }
      case 46: { // S2R: A1 = kind*4+axis
        const kind = A1[i] >> 2, ax = A1[i] & 3;
        ri[d] = kind === 0 ? (ax === 0 ? t % bdx : ax === 1 ? Math.floor(t / bdx) % block[1] : Math.floor(t / bdxy))
          : kind === 1 ? (ax === 0 ? bx : ax === 1 ? by : bz) : kind === 2 ? block[ax] : kind === 3 ? grid[ax] : t % WARP;
        break;
      }
      case 47: { const k = A1[i]; if (k >= params.length) fault(t, i, `param ${k} not provided`); regs[d] = params[k]; break; }
      case 48: return A0[i]; // BRA
      case 49: status[t] = 1; return i + 1; // BAR
      case 50: status[t] = 2; return i + 1; // EXIT
      case 51: break; // NOP
      case 54: fault(t, i, 'TEX is not supported by the edge core');
      default: fault(t, i, `op ${P.text[i]} requires lockstep scheduler`);
    }
    return i + 1;
  }

  function guardOk(t, i) {
    const g = GD[i];
    if (g < 0) return true;
    const pv = preds[t * NPRED + g] !== 0;
    return NG[i] ? !pv : pv;
  }

  function resetBlock() {
    pc.fill(0); status.fill(0); regs.fill(0); preds.fill(0); shared.fill(0); local.fill(0);
    for (let t = 0; t < n; t++) { const b = t * S + NREG; for (let k = 0; k < NIMM; k++) regs[b + k] = IMM[k]; }
  }

  // ---- 배리어 위상 실행: 스레드를 BAR/EXIT까지 연속 실행
  function blockPhased(x, y, z) {
    bx = x; by = y; bz = z; resetBlock();
    let cnt = 0;
    for (;;) {
      for (let t = 0; t < n; t++) {
        if (status[t] !== 0) continue;
        let p = pc[t];
        const pb = t * NPRED;
        for (;;) {
          const g = GD[p];
          if (g >= 0 && O[p] !== 49) {
            const pv = preds[pb + g];
            if (NG[p] ? pv !== 0 : pv === 0) { p++; continue; }
          }
          cnt++;
          p = step(t, p);
          if (status[t] !== 0) break;
        }
        pc[t] = p;
      }
      let waiting = 0;
      for (let t = 0; t < n; t++) if (status[t] === 1) { waiting++; status[t] = 0; }
      if (waiting === 0) break;
    }
    stats.laneInstrs += cnt;
  }

  // ---- 워프 락스텝 실행 (SHFL/VOTE 지원): 워프마다 전역 최소 PC 레인 그룹을 한 명령씩 실행
  function blockLockstep(x, y, z) {
    bx = x; by = y; bz = z; resetBlock();
    const nw = Math.ceil(n / WARP);
    let guardSteps = 0;
    for (;;) {
      let progressed = false, alive = 0, waiting = 0;
      for (let w = 0; w < nw; w++) {
        const t0 = w * WARP, t1 = Math.min(n, t0 + WARP);
        let cur = 1 << 30;
        for (let t = t0; t < t1; t++) if (status[t] === 0 && pc[t] < cur) cur = pc[t];
        if (cur === 1 << 30) continue;
        const lanes = [];
        for (let t = t0; t < t1; t++) if (status[t] === 0 && pc[t] === cur) lanes.push(t);
        progressed = true;
        const op = O[cur];
        const act = op === 49 ? lanes : lanes.filter(t => guardOk(t, cur));
        for (const t of lanes) pc[t] = cur + 1;
        if (op === 49) { for (const t of lanes) status[t] = 1; continue; }
        if (op === 52) { // SHFL: A1=원본 레지스터, A2=델타 슬롯
          const sub = SUB[cur], ws = t1 - t0;
          const out = act.map(t => {
            const lane = t - t0, dl = ri[t * S + A2[cur]];
            let src = sub === 0 ? lane - dl : sub === 1 ? lane + dl : sub === 2 ? lane ^ dl : dl & 31;
            if (src < 0 || src >= ws) src = lane;
            return regs[(t0 + src) * S + A1[cur]];
          });
          act.forEach((t, k) => { regs[t * S + A0[cur]] = out[k]; });
          stats.laneInstrs += act.length;
        } else if (op === 53) { // VOTE: A0=목적지, A1=프레디케이트
          const sub = SUB[cur];
          let mask = 0, any = false, all = true;
          for (const t of act) { const pv = preds[t * NPRED + A1[cur]] !== 0; if (pv) mask |= (1 << (t - t0)); any = any || pv; all = all && pv; }
          for (const t of act) {
            if (sub === 0) regs[t * S + A0[cur]] = mask >>> 0;
            else preds[t * NPRED + A0[cur]] = (sub === 1 ? any : all) ? 1 : 0;
          }
          stats.laneInstrs += act.length;
        } else {
          for (const t of act) {
            stats.laneInstrs++;
            const np = step(t, cur);
            if (op === 48) pc[t] = np;
          }
        }
      }
      for (let t = 0; t < n; t++) { if (status[t] !== 2) alive++; if (status[t] === 1) waiting++; }
      if (alive === 0) break;
      if (!progressed || (waiting === alive && waiting > 0)) {
        if (waiting === 0) throw new Error('deadlock');
        for (let t = 0; t < n; t++) if (status[t] === 1) status[t] = 0;
      }
      if (++guardSteps > 50_000_000) throw new Error('max steps exceeded (infinite loop?)');
    }
  }

  return { blockPhased, blockLockstep, stats };
}

// ===================================================================== 샤딩 (낙관적 병렬 + 검증 + 폴백)

/** 샤드 결과 추출: 메모리 델타(run 압축) + 원자 집계 + 먼저 읽은 구간 */
export function collectShard(gpu, initial, stats) {
  const t = stats.track, words = gpu.size >> 2, runs = [], vals = [];
  const hi = gpu.top >> 2;
  let start = -1;
  for (let w = 0; w <= hi; w++) {
    const changed = w < hi && t.dirty[w] && gpu.u32[w] !== initial[w] && !t.atom.has(w);
    if (changed && start < 0) start = w;
    if (!changed && start >= 0) {
      runs.push(start, w - start);
      for (let k = start; k < w; k++) vals.push(gpu.u32[k]);
      start = -1;
    }
  }
  const reads = [];
  start = -1;
  for (let w = 0; w <= hi; w++) {
    const r = w < hi && t.readFirst[w];
    if (r && start < 0) start = w;
    if (!r && start >= 0) { reads.push(start, w - start); start = -1; }
  }
  const atoms = [];
  for (const [w, e] of t.atom) atoms.push([w, e.sub, e.sub === 1 ? e.acc : e.acc >>> 0]);
  return { runs, vals, atoms, reads, mixed: !!t.mixed, noncomm: t.noncomm, laneInstrs: stats.laneInstrs, blocks: stats.blocks};
}

/** 병합 + 검증. 성공 시 최종 메모리(Uint32Array) 반환, 실패 시 {fail:reason} */
export function mergeShards(initial, results, top) {
  const hi = top >> 2;
  const writer = new Int16Array(hi).fill(-1); // -1 없음, -2 복수 샤드
  const out = new Uint32Array(initial.subarray(0, hi));
  const seen = new Uint32Array(hi); // 평범한 쓰기 값 (충돌 검사용)
  const plainBy = new Int16Array(hi).fill(-1);
  for (let s = 0; s < results.length; s++) {
    const r = results[s];
    if (r.noncomm) return { fail: 'non-commutative atomic (EXCH/CAS) cannot be sharded' };
    if (r.mixed) return { fail: 'plain store and atomic touched the same word' };
    let k = 0;
    for (let q = 0; q < r.runs.length; q += 2) {
      for (let w = r.runs[q]; w < r.runs[q] + r.runs[q + 1]; w++, k++) {
        const v = r.vals[k];
        if (plainBy[w] >= 0 && plainBy[w] !== s && seen[w] !== v) return { fail: `write conflict at word ${w}` };
        if (plainBy[w] < 0) { plainBy[w] = s; seen[w] = v; out[w] = v; writer[w] = s; }
        else if (plainBy[w] !== s) writer[w] = -2;
      }
    }
  }
  // 원자 집계: 같은 주소는 샤드 간 가환 결합 후 초기값에 한 번 적용
  const agg = new Map();
  for (let s = 0; s < results.length; s++) {
    for (const [w, sub, acc] of results[s].atoms) {
      if (plainBy[w] >= 0) return { fail: 'plain store and atomic touched the same word' };
      const e = agg.get(w);
      if (!e) { agg.set(w, { sub, acc, owners: new Set([s]) }); continue; }
      if (e.sub !== sub) return { fail: 'mixed atomic ops on one word' };
      e.owners.add(s);
      switch (sub) {
        case 0: e.acc = (e.acc + acc) >>> 0; break;
        case 1: e.acc += acc; break;
        case 2: e.acc = Math.min(e.acc | 0, acc | 0) >>> 0; break;
        case 3: e.acc = Math.max(e.acc | 0, acc | 0) >>> 0; break;
        case 4: e.acc = (e.acc & acc) >>> 0; break;
        case 5: e.acc = (e.acc | acc) >>> 0; break;
        default: e.acc = (e.acc ^ acc) >>> 0;
      }
    }
  }
  for (const [w, e] of agg) {
    const base = initial[w];
    switch (e.sub) {
      case 0: out[w] = (base + e.acc) >>> 0; break;
      case 1: out[w] = f2u(Math.fround(u2f(base) + e.acc)); break;
      case 2: out[w] = Math.min(base | 0, e.acc | 0) >>> 0; break;
      case 3: out[w] = Math.max(base | 0, e.acc | 0) >>> 0; break;
      case 4: out[w] = (base & e.acc) >>> 0; break;
      case 5: out[w] = (base | e.acc) >>> 0; break;
      default: out[w] = (base ^ e.acc) >>> 0;
    }
    writer[w] = e.owners.size > 1 ? -2 : [...e.owners][0];
  }
  // 검증: 어떤 샤드가 '자기 쓰기 이전에' 읽은 주소를 다른 샤드가 썼다면 RAW 위험
  for (let s = 0; s < results.length; s++) {
    const r = results[s];
    for (let q = 0; q < r.reads.length; q += 2) {
      for (let w = r.reads[q]; w < r.reads[q] + r.reads[q + 1]; w++) {
        const wr = writer[w];
        if (wr === -2 || (wr >= 0 && wr !== s)) return { fail: `cross-shard read-after-write hazard at word ${w}` };
      }
    }
  }
  return { memory: out };
}

export function planShards(nblocks, k) {
  k = Math.max(1, Math.min(k, nblocks));
  const cuts = Array.from({ length: k + 1 }, (_, i) => Math.floor(nblocks * i / k));
  return cuts.slice(0, -1).map((c, i) => [c, cuts[i + 1]]);
}

/**
 * 샤딩 실행. runShard(spec) -> Promise<collectShard 결과> (Node: 로컬 함수, Worker: 서비스 바인딩 fetch)
 * 반환: {mode:'sharded'|'serial', reason?, shards, laneInstrs}
 */
export async function shardedLaunch(gpu, prog, grid, block, params, opts, k, runShard) {
  const g = dim3(grid), nblocks = g[0] * g[1] * g[2];
  if (typeof prog === 'string') prog = assemble(prog);
  const serial = (reason) => {
    const st = gpu.launch(prog, grid, block, params, { ...opts, track: false });
    return { mode: 'serial', reason, shards: 1, laneInstrs: st.laneInstrs };
  };
  if (k <= 1 || nblocks < 2) return serial('single shard');
  if (prog.hasAtomic && !prog.atomicDead) return serial('atomic result is used (not shardable)');
  const initial = new Uint32Array(gpu.u32.slice(0, gpu.top >> 2));
  const specs = planShards(nblocks, k).map(blocks => ({ blocks, top: gpu.top }));
  const results = await Promise.all(specs.map(sp => runShard(sp, initial)));
  const m = mergeShards(initial, results, gpu.top);
  if (m.fail) return serial(m.fail);
  gpu.u32.set(m.memory);
  return { mode: 'sharded', shards: results.length, laneInstrs: results.reduce((a, r) => a + r.laneInstrs, 0) };
}

/** 로컬 샤드 실행기 (Node/테스트/Worker 내부 공용): 초기 메모리에서 샤드를 실행하고 결과를 수집 */
export function execShard(size, initial, top, prog, grid, block, params, opts, blocks) {
  const g = new VGPU({ memBytes: size });
  g.u32.set(initial); g.top = top;
  const before = new Uint32Array(initial);
  const st = g.launch(prog, grid, block, params, { ...opts, blocks, track: true });
  return collectShard(g, before, st);
}

// ===================================================================== 전송 유틸
export function toB64(ta) {
  const u8 = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(b64, Ctor = Uint8Array) {
  const s = atob(b64), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return new Ctor(u8.buffer, 0, Math.floor(u8.length / Ctor.BYTES_PER_ELEMENT));
}
