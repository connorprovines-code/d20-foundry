import { describe, expect, it } from 'vitest';
import { foldCoins, goldToPrice, hasUnfoldedCoins, priceToGold, purseToCoins, samePurse } from '../src/sync/coins.js';

describe('coin folding', () => {
  it('folds platinum into gold x10 and electrum into silver x5', () => {
    expect(foldCoins({ pp: 3, gp: 12, ep: 4, sp: 7, cp: 9 })).toEqual({ gold: 42, silver: 27, copper: 9 });
  });

  it('treats missing denominations as zero', () => {
    expect(foldCoins({ gp: 5 })).toEqual({ gold: 5, silver: 0, copper: 0 });
    expect(hasUnfoldedCoins({ gp: 5 })).toBe(false);
    expect(hasUnfoldedCoins({ gp: 5, ep: 1 })).toBe(true);
  });

  it('keeps dnd5e fractional coins', () => {
    expect(foldCoins({ pp: 0.5, gp: 1.25, ep: 0, sp: 0, cp: 0 })).toEqual({ gold: 6.25, silver: 0, copper: 0 });
  });

  it('writes a purse back with pp = 0 and ep = 0', () => {
    expect(purseToCoins({ gold: 42, silver: 27, copper: 9 })).toEqual({ pp: 0, gp: 42, ep: 0, sp: 27, cp: 9 });
  });

  it('moves fractions down a denomination for integer-only systems', () => {
    expect(purseToCoins({ gold: 12.57, silver: 1.5, copper: 2 }, { integer: true }))
      .toEqual({ pp: 0, gp: 12, ep: 0, sp: 6, cp: 14 });
    // Totals are preserved in copper: 12.57 gp + 1.5 sp + 2 cp = 1274 cp
    const c = purseToCoins({ gold: 12.57, silver: 1.5, copper: 2 }, { integer: true });
    expect(c.gp * 100 + c.sp * 10 + c.cp).toBe(1274);
  });

  it('compares purses to 4 decimals', () => {
    expect(samePurse({ gold: 0.1 + 0.2, silver: 0, copper: 0 }, { gold: 0.3, silver: 0, copper: 0 })).toBe(true);
    expect(samePurse({ gold: 1, silver: 0, copper: 0 }, { gold: 1, silver: 1, copper: 0 })).toBe(false);
  });

  it('converts pf2e price objects to gp and back', () => {
    expect(priceToGold({ pp: 1, gp: 2, sp: 3, cp: 4 })).toBe(12.34);
    expect(goldToPrice(12.34)).toEqual({ gp: 12, sp: 3, cp: 4 });
    expect(goldToPrice(0.01)).toEqual({ cp: 1 });
    expect(goldToPrice(0)).toEqual({});
  });
});
