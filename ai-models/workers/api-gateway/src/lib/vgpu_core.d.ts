export class VGPU {
  constructor(opts?: { memBytes?: number });
  top: number;
  size: number;
  malloc(bytes: number): number;
  write(ptr: number, ta: ArrayBufferView): void;
  read<T extends ArrayBufferView>(ptr: number, Ctor: { new (b: ArrayBuffer): T; BYTES_PER_ELEMENT: number }, count: number): T;
  launch(prog: unknown, grid: number | number[], block: number | number[], params?: Array<number | { f: number }>, opts?: Record<string, unknown>): { blocks: number; threads: number; laneInstrs: number };
}
export function assemble(src: string): unknown;
