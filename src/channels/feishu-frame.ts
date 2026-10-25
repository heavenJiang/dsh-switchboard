/**
 * The Feishu persistent connection's wire frame (`pbbp2.Frame`, protobuf),
 * encoded and decoded by hand: nine fields are not worth a protobuf runtime.
 * 64-bit ids are BigInts because the server reads them back from replies.
 */

export interface FrameHeader {
  readonly key: string
  readonly value: string
}

export interface Frame {
  readonly SeqID: bigint
  readonly LogID: bigint
  readonly service: number
  /** 0 control (ping, pong), 1 data (events). */
  readonly method: number
  readonly headers: readonly FrameHeader[]
  readonly payloadEncoding?: string
  readonly payloadType?: string
  readonly payload?: Uint8Array
  readonly LogIDNew?: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Protobuf writer for varints and length-delimited fields. */
class Writer {
  private readonly out: number[] = []

  varint(value: bigint): void {
    let rest = BigInt.asUintN(64, value)
    while (rest >= 0x80n) {
      this.out.push(Number(rest & 0x7fn) | 0x80)
      rest >>= 7n
    }
    this.out.push(Number(rest))
  }

  uint(field: number, value: bigint): void {
    this.varint(BigInt(field << 3))
    this.varint(value)
  }

  bytes(field: number, data: Uint8Array): void {
    this.varint(BigInt((field << 3) | 2))
    this.varint(BigInt(data.byteLength))
    for (const byte of data) this.out.push(byte)
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

/** Protobuf reader yielding each field once. */
class Reader {
  private at = 0

  constructor(private readonly data: Uint8Array) {}

  get done(): boolean {
    return this.at >= this.data.byteLength
  }

  varint(): bigint {
    let value = 0n
    let shift = 0n
    for (;;) {
      if (this.at >= this.data.byteLength) throw new Error('feishu frame: truncated varint')
      const byte = this.data[this.at++]!
      value |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return value
      shift += 7n
    }
  }

  /** The next field: its number, and a varint or the bytes of a length-delimited value. */
  field(): { field: number; value: bigint | Uint8Array | undefined } {
    const tag = Number(this.varint())
    const wire = tag & 7
    const field = tag >>> 3
    if (wire === 0) return { field, value: this.varint() }
    if (wire === 2) {
      const length = Number(this.varint())
      if (this.at + length > this.data.byteLength) throw new Error('feishu frame: truncated field')
      const value = this.data.subarray(this.at, this.at + length)
      this.at += length
      return { field, value }
    }
    if (wire === 1) this.at += 8
    else if (wire === 5) this.at += 4
    else throw new Error(`feishu frame: unsupported wire type ${wire}`)
    return { field, value: undefined }
  }
}

/** Serialize a frame. */
export function encodeFrame(frame: Frame): Uint8Array {
  const writer = new Writer()
  writer.uint(1, frame.SeqID)
  writer.uint(2, frame.LogID)
  writer.uint(3, BigInt(frame.service))
  writer.uint(4, BigInt(frame.method))
  for (const header of frame.headers) {
    const inner = new Writer()
    inner.bytes(1, encoder.encode(header.key))
    inner.bytes(2, encoder.encode(header.value))
    writer.bytes(5, inner.finish())
  }
  if (frame.payloadEncoding !== undefined) writer.bytes(6, encoder.encode(frame.payloadEncoding))
  if (frame.payloadType !== undefined) writer.bytes(7, encoder.encode(frame.payloadType))
  if (frame.payload !== undefined) writer.bytes(8, frame.payload)
  if (frame.LogIDNew !== undefined) writer.bytes(9, encoder.encode(frame.LogIDNew))
  return writer.finish()
}

/** Parse a frame; unknown fields are skipped. */
export function decodeFrame(data: Uint8Array): Frame {
  const reader = new Reader(data)
  let SeqID = 0n
  let LogID = 0n
  let service = 0
  let method = 0
  const headers: FrameHeader[] = []
  const optional: { payloadEncoding?: string; payloadType?: string; payload?: Uint8Array; LogIDNew?: string } = {}
  while (!reader.done) {
    const { field, value } = reader.field()
    if (typeof value === 'bigint') {
      if (field === 1) SeqID = value
      else if (field === 2) LogID = value
      else if (field === 3) service = Number(BigInt.asIntN(32, value))
      else if (field === 4) method = Number(BigInt.asIntN(32, value))
    } else if (value !== undefined) {
      if (field === 5) headers.push(decodeHeader(value))
      else if (field === 6) optional.payloadEncoding = decoder.decode(value)
      else if (field === 7) optional.payloadType = decoder.decode(value)
      else if (field === 8) optional.payload = value
      else if (field === 9) optional.LogIDNew = decoder.decode(value)
    }
  }
  return { SeqID, LogID, service, method, headers, ...optional }
}

function decodeHeader(data: Uint8Array): FrameHeader {
  const reader = new Reader(data)
  let key = ''
  let value = ''
  while (!reader.done) {
    const next = reader.field()
    if (next.value instanceof Uint8Array && next.field === 1) key = decoder.decode(next.value)
    else if (next.value instanceof Uint8Array && next.field === 2) value = decoder.decode(next.value)
  }
  return { key, value }
}
