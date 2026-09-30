// Coin conversion between Foundry denominations and D20 purses.
// D20 purses hold gold, silver and copper. Foundry platinum folds into gold (x10) and
// electrum into silver (x5); the other coins keep their denomination.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Rounds away float noise (0.1 + 0.2) without losing D20's decimal gold. */
export const roundCoin = (v) => Math.round(num(v) * 10000) / 10000;

/** Foundry coins {pp, gp, ep, sp, cp} to a D20 purse {gold, silver, copper}. */
export function foldCoins(coins = {}) {
  return {
    gold: roundCoin(num(coins.gp) + 10 * num(coins.pp)),
    silver: roundCoin(num(coins.sp) + 5 * num(coins.ep)),
    copper: roundCoin(num(coins.cp)),
  };
}

/** True when a Foundry purse still holds platinum or electrum that should be folded. */
export const hasUnfoldedCoins = (coins = {}) => num(coins.pp) !== 0 || num(coins.ep) !== 0;

/** True for a missing purse or one holding no coins. */
export const isEmptyPurse = (p) => !p || (num(p.gold) === 0 && num(p.silver) === 0 && num(p.copper) === 0);

export function samePurse(a, b) {
  if (!a || !b) return false;
  return roundCoin(a.gold) === roundCoin(b.gold)
    && roundCoin(a.silver) === roundCoin(b.silver)
    && roundCoin(a.copper) === roundCoin(b.copper);
}

/**
 * A D20 purse as Foundry coins with pp = 0 and ep = 0.
 * With `integer`, fractions move down a denomination (12.5 gp = 12 gp 5 sp) and copper
 * rounds to the nearest coin, for systems whose currency fields are integers (pf1, pf2e).
 */
export function purseToCoins(purse = {}, { integer = false } = {}) {
  const gold = Math.max(0, num(purse.gold));
  const silver = Math.max(0, num(purse.silver));
  const copper = Math.max(0, num(purse.copper));
  if (!integer) {
    return { pp: 0, gp: roundCoin(gold), ep: 0, sp: roundCoin(silver), cp: roundCoin(copper) };
  }
  const gp = Math.floor(gold + 1e-9);
  const goldRemainderCp = Math.round((gold - gp) * 100);
  const sp = Math.floor(silver + 1e-9);
  const silverRemainderCp = Math.round((silver - sp) * 10);
  const extraSp = Math.floor(goldRemainderCp / 10);
  const cp = Math.round(copper) + (goldRemainderCp % 10) + silverRemainderCp;
  return { pp: 0, gp, ep: 0, sp: sp + extraSp, cp };
}

/** gp value from a {pp, gp, sp, cp} price object. */
export const priceToGold = (price = {}) =>
  roundCoin(num(price.pp) * 10 + num(price.gp) + num(price.sp) / 10 + num(price.cp) / 100);

/**
 * A gp value as the fewest coins with no fractional coin: 1.5 gp = { gp: 1, sp: 5 }.
 * Used for pf2e prices, which are stored per denomination.
 */
export function goldToPrice(gold) {
  let copper = Math.round(Math.max(0, num(gold)) * 100);
  const gp = Math.floor(copper / 100);
  copper -= gp * 100;
  const sp = Math.floor(copper / 10);
  copper -= sp * 10;
  const out = {};
  if (gp) out.gp = gp;
  if (sp) out.sp = sp;
  if (copper) out.cp = copper;
  return out;
}
