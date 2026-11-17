/**
 * atproto TIDs: the record key the calendar lexicons declare (`"key": "tid"`).
 * 13 base32-sortable chars: 53 bits of microseconds since the epoch, then a
 * 10-bit clock id. Monotonic within one process.
 */

const B32 = "234567abcdefghijklmnopqrstuvwxyz";
let last = 0n;

export function tid(nowMicros?: bigint, clockId = Math.floor(Math.random() * 1024)): string {
  let us = nowMicros ?? BigInt(Date.now()) * 1000n;
  if (nowMicros === undefined) {
    if (us <= last) us = last + 1n;
    last = us;
  }
  let v = (us << 10n) | BigInt(clockId & 1023);
  let s = "";
  for (let i = 0; i < 13; i++) {
    s = B32[Number(v & 31n)] + s;
    v >>= 5n;
  }
  return s;
}

/** The atproto TID syntax. */
export const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
