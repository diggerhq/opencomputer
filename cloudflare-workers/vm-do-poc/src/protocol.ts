export interface ExecRequest {
  requestId: number;
  command: string;
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
}

export interface ExecResult {
  requestId: number;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  error?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return bytes;
}

function fieldVarint(field: number, value: number): number[] {
  return [...varint(field << 3), ...varint(value)];
}

function fieldBytes(field: number, value: Uint8Array): number[] {
  return [...varint((field << 3) | 2), ...varint(value.byteLength), ...value];
}

function stringField(field: number, value: string): number[] {
  return value ? fieldBytes(field, encoder.encode(value)) : [];
}

function envEntry(key: string, value: string): Uint8Array {
  return Uint8Array.from([...stringField(1, key), ...stringField(2, value)]);
}

export function encodeExec(request: ExecRequest): ArrayBuffer {
  const bytes = [
    ...fieldVarint(1, request.requestId),
    ...stringField(2, request.command),
    ...stringField(3, request.cwd),
    ...fieldVarint(4, request.timeoutMs),
  ];
  for (const [key, value] of Object.entries(request.env)) bytes.push(...fieldBytes(5, envEntry(key, value)));
  return Uint8Array.from(bytes).buffer;
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.byteLength;
  }

  uint32(): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (this.offset >= this.bytes.byteLength) throw new Error("truncated protobuf varint");
      const byte = this.bytes[this.offset++];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value >>> 0;
    }
    throw new Error("protobuf varint exceeds uint32");
  }

  bytesValue(): Uint8Array {
    const length = this.uint32();
    const end = this.offset + length;
    if (end > this.bytes.byteLength) throw new Error("truncated protobuf bytes");
    const value = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  skip(wireType: number): void {
    if (wireType === 0) {
      this.uint32();
      return;
    }
    if (wireType === 2) {
      this.bytesValue();
      return;
    }
    throw new Error(`unsupported protobuf wire type ${wireType}`);
  }
}

function zigZagDecode(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}

export function decodeResult(input: ArrayBuffer): ExecResult {
  const reader = new Reader(new Uint8Array(input));
  const result: ExecResult = { requestId: 0, exitCode: 0, durationMs: 0, stdout: "", stderr: "" };
  while (!reader.done) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    const wireType = tag & 7;
    if (field === 1 && wireType === 0) result.requestId = reader.uint32();
    else if (field === 2 && wireType === 0) result.exitCode = zigZagDecode(reader.uint32());
    else if (field === 3 && wireType === 0) result.durationMs = reader.uint32();
    else if (field === 4 && wireType === 2) result.stdout = decoder.decode(reader.bytesValue());
    else if (field === 5 && wireType === 2) result.stderr = decoder.decode(reader.bytesValue());
    else if (field === 6 && wireType === 2) result.error = decoder.decode(reader.bytesValue());
    else reader.skip(wireType);
  }
  return result;
}
