/**
 * Small uuid helper. Prefers `crypto.randomUUID()` when available, falls back
 * to a `Math.random`-based generator because `http://<lan-ip>:5173` is NOT a
 * secure context on every browser and `crypto.randomUUID` is gated on it in
 * Safari (and older Firefox).
 */

export function uuid(): string {
  const g = globalThis.crypto
  if (g && typeof g.randomUUID === 'function') {
    try {
      return g.randomUUID()
    } catch {
      // fall through
    }
  }
  return `${hex(4)}${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`
}

function hex(bytes: number): string {
  let out = ''
  for (let i = 0; i < bytes; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0')
  }
  return out
}
