// Minimal OTLP/HTTP protobuf encoder for logs (ExportLogsServiceRequest),
// enough to ship our tail records to Sazabi. Hand-rolled because the
// generated protobuf libraries pull in code generation that Workers forbid,
// and the subset we need is a handful of fields:
//
//   ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
//   ResourceLogs  { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
//   Resource      { repeated KeyValue attributes = 1; }
//   ScopeLogs     { InstrumentationScope scope = 1; repeated LogRecord log_records = 2; }
//   InstrumentationScope { string name = 1; }
//   LogRecord     { fixed64 time_unix_nano = 1; SeverityNumber severity_number = 2;
//                   string severity_text = 3; AnyValue body = 5;
//                   repeated KeyValue attributes = 6; }
//   KeyValue      { string key = 1; AnyValue value = 2; }
//   AnyValue      { string string_value = 1; bool bool_value = 2;
//                   int64 int_value = 3; double double_value = 4; }

const SEVERITY_NUMBER: Record<string, number> = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 };

// Envelope fields that describe the producer rather than the event; they
// become resource attributes so each Worker is one OTLP resource.
const RESOURCE_FIELDS = new Set(["service", "service_id", "cell_id", "region", "script_version"]);
// Fields already carried by the record's own protobuf fields.
const RECORD_FIELDS = new Set(["_time", "time", "level", "msg"]);

type Scalar = string | number | boolean;

class Writer {
  private chunks: number[] = [];

  varint(n: number | bigint): this {
    let v = BigInt(n);
    if (v < 0n) v += 1n << 64n;
    while (v > 0x7fn) {
      this.chunks.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.chunks.push(Number(v));
    return this;
  }

  tag(field: number, wireType: number): this {
    return this.varint((field << 3) | wireType);
  }

  bytes(field: number, data: Uint8Array): this {
    this.tag(field, 2).varint(data.length);
    for (const b of data) this.chunks.push(b);
    return this;
  }

  string(field: number, s: string): this {
    return this.bytes(field, new TextEncoder().encode(s));
  }

  message(field: number, w: Writer): this {
    return this.bytes(field, w.finish());
  }

  fixed64(field: number, n: bigint): this {
    this.tag(field, 1);
    for (let i = 0n; i < 8n; i++) this.chunks.push(Number((n >> (8n * i)) & 0xffn));
    return this;
  }

  double(field: number, n: number): this {
    this.tag(field, 1);
    const buf = new DataView(new ArrayBuffer(8));
    buf.setFloat64(0, n, true);
    for (let i = 0; i < 8; i++) this.chunks.push(buf.getUint8(i));
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

function anyValue(v: Scalar): Writer {
  const w = new Writer();
  if (typeof v === "string") w.string(1, v);
  else if (typeof v === "boolean") w.tag(2, 0).varint(v ? 1 : 0);
  else if (Number.isSafeInteger(v)) w.tag(3, 0).varint(v);
  else w.double(4, v);
  return w;
}

function keyValue(key: string, v: Scalar): Writer {
  return new Writer().string(1, key).message(2, anyValue(v));
}

function scalar(v: unknown): Scalar | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function logRecord(record: Record<string, unknown>): Writer {
  const w = new Writer();
  const ms = Date.parse(String(record._time ?? record.time ?? ""));
  w.fixed64(1, BigInt(Number.isNaN(ms) ? Date.now() : ms) * 1_000_000n);
  const level = String(record.level ?? "INFO");
  w.tag(2, 0).varint(SEVERITY_NUMBER[level] ?? 9);
  w.string(3, level);
  w.message(5, anyValue(String(record.msg ?? "")));
  for (const [key, value] of Object.entries(record)) {
    if (RECORD_FIELDS.has(key) || RESOURCE_FIELDS.has(key)) continue;
    const v = scalar(value);
    if (v !== undefined) w.message(6, keyValue(key, v));
  }
  return w;
}

// Encodes tail records (the same objects sent to Axiom) as one
// ExportLogsServiceRequest, one ResourceLogs per producing Worker.
export function encodeLogs(records: Record<string, unknown>[]): Uint8Array {
  const byResource = new Map<string, Record<string, unknown>[]>();
  for (const record of records) {
    const key = JSON.stringify([...RESOURCE_FIELDS].map((f) => record[f]));
    const group = byResource.get(key);
    if (group) group.push(record);
    else byResource.set(key, [record]);
  }

  const request = new Writer();
  for (const group of byResource.values()) {
    const first = group[0]!;
    const resource = new Writer();
    resource.message(1, keyValue("service.name", String(first.service ?? "unknown")));
    for (const field of RESOURCE_FIELDS) {
      const v = scalar(first[field]);
      if (v !== undefined) resource.message(1, keyValue(field, v));
    }
    const scope = new Writer().message(1, new Writer().string(1, "opencomputer-log-tail"));
    for (const record of group) scope.message(2, logRecord(record));
    request.message(1, new Writer().message(1, resource).message(2, scope));
  }
  return request.finish();
}
