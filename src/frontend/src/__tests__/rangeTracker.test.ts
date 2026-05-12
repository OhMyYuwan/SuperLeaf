import { describe, it, expect } from 'vitest'
import { mapRange, mapRangeThrough, type DocChange, type Range } from '../services/rangeTracker'

describe('rangeTracker', () => {
  describe('mapRange', () => {
    const range: Range = { from: 10, to: 20 }

    it('case 1: change after range → no effect', () => {
      const c: DocChange = { from: 25, to: 30, insertLen: 3 }
      expect(mapRange(range, c)).toEqual({ from: 10, to: 20 })
    })

    it('case 2: change before range → shift both endpoints', () => {
      const c: DocChange = { from: 0, to: 2, insertLen: 5 }
      // shift = 5 - 2 = +3
      expect(mapRange(range, c)).toEqual({ from: 13, to: 23 })
    })

    it('case 2b: insert (no delete) before range → shift right', () => {
      const c: DocChange = { from: 5, to: 5, insertLen: 4 }
      expect(mapRange(range, c)).toEqual({ from: 14, to: 24 })
    })

    it('case 3: change engulfs entire range → null', () => {
      const c: DocChange = { from: 8, to: 22, insertLen: 1 }
      expect(mapRange(range, c)).toBeNull()
    })

    it('case 4: change inside range → expand range', () => {
      const c: DocChange = { from: 12, to: 12, insertLen: 3 }
      // pure insert inside → range grows by 3
      expect(mapRange(range, c)).toEqual({ from: 10, to: 23 })
    })

    it('case 4b: delete inside range → shrink range', () => {
      const c: DocChange = { from: 12, to: 15, insertLen: 0 }
      // delete 3 chars inside → range shrinks by 3
      expect(mapRange(range, c)).toEqual({ from: 10, to: 17 })
    })

    it('case 4c: replace inside range → adjust range end', () => {
      const c: DocChange = { from: 12, to: 15, insertLen: 5 }
      // shift = 5 - 3 = +2
      expect(mapRange(range, c)).toEqual({ from: 10, to: 22 })
    })

    it('case 5: left overlap → shrink from left', () => {
      const c: DocChange = { from: 8, to: 14, insertLen: 2 }
      // newFrom = 8 + 2 = 10, shift = 2 - 6 = -4, newTo = 20 + (-4) = 16
      expect(mapRange(range, c)).toEqual({ from: 10, to: 16 })
    })

    it('case 5b: left overlap that collapses range → null', () => {
      const c: DocChange = { from: 5, to: 19, insertLen: 0 }
      // newFrom = 5 + 0 = 5, shift = 0 - 14 = -14, newTo = 20 + (-14) = 6
      // 6 > 5 → { from: 5, to: 6 }
      expect(mapRange(range, c)).toEqual({ from: 5, to: 6 })
    })

    it('case 6: right overlap → truncate at change start', () => {
      const c: DocChange = { from: 15, to: 25, insertLen: 3 }
      expect(mapRange(range, c)).toEqual({ from: 10, to: 15 })
    })
  })

  describe('mapRangeThrough', () => {
    it('applies multiple changes sequentially', () => {
      const range: Range = { from: 10, to: 20 }
      const changes: DocChange[] = [
        { from: 0, to: 0, insertLen: 5 },  // insert 5 at start → range becomes 15..25
        { from: 17, to: 17, insertLen: 2 }, // insert 2 inside → range becomes 15..27
      ]
      expect(mapRangeThrough(range, changes)).toEqual({ from: 15, to: 27 })
    })

    it('returns null if any change destroys the range', () => {
      const range: Range = { from: 10, to: 20 }
      const changes: DocChange[] = [
        { from: 5, to: 25, insertLen: 1 }, // engulfs
        { from: 0, to: 0, insertLen: 3 },  // would shift, but already null
      ]
      expect(mapRangeThrough(range, changes)).toBeNull()
    })
  })
})
