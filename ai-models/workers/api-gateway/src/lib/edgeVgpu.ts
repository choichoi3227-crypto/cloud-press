/**
 * edgeGenerator의 ConvTranspose2d(+bias+활성화)를 vgpu ISA 커널로 실행하는 백엔드.
 * 한 스레드 = 출력 원소 1개 (gather 방식). 커널은 한 번만 어셈블해 isolate에 캐시한다.
 */
import { VGPU, assemble } from "./vgpu_core.js";

const KERNEL = `
S2R r0, ctaid.x
S2R r1, ntid.x
S2R r2, tid.x
IMUL r0, r0, r1
IADD r0, r0, r2
PARAM r3, 14
ISETP.GE p0, r0, r3
@p0 EXIT
PARAM r4, 8
PARAM r5, 9
IMUL r6, r4, r5
IDIV r7, r0, r6
IMOD r8, r0, r6
IDIV r9, r8, r5
IMOD r10, r8, r5
PARAM r11, 2
SHL r12, r7, #2
IADD r11, r11, r12
LD r13, [r11]
PARAM r14, 10
PARAM r15, 11
PARAM r16, 12
PARAM r17, 4
PARAM r18, 5
PARAM r19, 6
PARAM r20, 7
PARAM r21, 0
PARAM r22, 1
IMUL r23, r19, r20
IMUL r24, r18, r14
IMUL r24, r24, r14
SHL r35, r23, #2
SHL r36, r24, #2
MOV r25, #0
kyloop:
ISETP.GE p1, r25, r14
@p1 BRA kydone
IADD r26, r9, r16
ISUB r26, r26, r25
ISETP.LT p2, r26, #0
@p2 BRA kynext
IMOD r27, r26, r15
ISETP.NE p2, r27, #0
@p2 BRA kynext
IDIV r28, r26, r15
ISETP.GE p2, r28, r19
@p2 BRA kynext
MOV r29, #0
kxloop:
ISETP.GE p1, r29, r14
@p1 BRA kynext
IADD r30, r10, r16
ISUB r30, r30, r29
ISETP.LT p2, r30, #0
@p2 BRA kxnext
IMOD r31, r30, r15
ISETP.NE p2, r31, #0
@p2 BRA kxnext
IDIV r32, r30, r15
ISETP.GE p2, r32, r20
@p2 BRA kxnext
IMUL r33, r28, r20
IADD r33, r33, r32
SHL r33, r33, #2
IADD r33, r33, r21
IMUL r34, r7, r14
IADD r34, r34, r25
IMUL r34, r34, r14
IADD r34, r34, r29
SHL r34, r34, #2
IADD r34, r34, r22
MOV r37, #0
ISUB r46, r17, #3
ci4loop:
ISETP.GE p3, r37, r46
@p3 BRA ciloop
LD r38, [r33]
IADD r47, r33, r35
LD r48, [r47]
IADD r49, r47, r35
LD r50, [r49]
IADD r51, r49, r35
LD r52, [r51]
LD r39, [r34]
IADD r53, r34, r36
LD r54, [r53]
IADD r55, r53, r36
LD r56, [r55]
IADD r57, r55, r36
LD r58, [r57]
FFMA r13, r38, r39, r13
FFMA r13, r48, r54, r13
FFMA r13, r50, r56, r13
FFMA r13, r52, r58, r13
IADD r33, r51, r35
IADD r34, r57, r36
IADD r37, r37, #4
BRA ci4loop
ciloop:
ISETP.GE p3, r37, r17
@p3 BRA kxnext
LD r38, [r33]
LD r39, [r34]
FFMA r13, r38, r39, r13
IADD r33, r33, r35
IADD r34, r34, r36
IADD r37, r37, #1
BRA ciloop
kxnext:
IADD r29, r29, #1
BRA kxloop
kynext:
IADD r25, r25, #1
BRA kyloop
kydone:
PARAM r40, 13
ISETP.EQ p4, r40, #0
@p4 FMAX r13, r13, #0.0
@p4 BRA store
FMIN r13, r13, #15.0
FMAX r13, r13, #-15.0
FMUL r41, r13, #2.885390082
FEX2 r41, r41
FSUB r42, r41, #1.0
FADD r43, r41, #1.0
FDIV r13, r42, r43
store:
PARAM r44, 3
SHL r45, r0, #2
IADD r44, r44, r45
ST [r44], r13
EXIT
`;

let prog: unknown = null;
let gpu: VGPU | null = null;

export interface ConvLayer {
  cin: number; cout: number; k: number; stride: number; pad: number;
  act: "relu" | "tanh"; w: Float32Array; b: Float32Array;
}

/** 한 레이어를 vgpu에서 실행해 (cout,oh,ow) 출력을 반환 (활성화 포함). */
export function vgpuLayer(x: Float32Array, h: number, w: number, L: ConvLayer): { y: Float32Array; h: number; w: number } {
  const oh = (h - 1) * L.stride - 2 * L.pad + L.k;
  const ow = (w - 1) * L.stride - 2 * L.pad + L.k;
  const total = L.cout * oh * ow;
  const need = (x.length + L.w.length + L.b.length + total) * 4 + 4096;
  if (!gpu || gpu.size < need) gpu = new VGPU({ memBytes: Math.max(need, 1 << 20) });
  gpu.top = 256;
  if (!prog) prog = assemble(KERNEL);
  const px = gpu.malloc(x.length * 4), pw = gpu.malloc(L.w.length * 4);
  const pb = gpu.malloc(L.b.length * 4), py = gpu.malloc(total * 4);
  gpu.write(px, x); gpu.write(pw, L.w); gpu.write(pb, L.b);
  const BS = 256;
  gpu.launch(prog, Math.ceil(total / BS), BS,
    [px, pw, pb, py, L.cin, L.cout, h, w, oh, ow, L.k, L.stride, L.pad, L.act === "relu" ? 0 : 1, total]);
  return { y: gpu.read(py, Float32Array, total), h: oh, w: ow };
}
