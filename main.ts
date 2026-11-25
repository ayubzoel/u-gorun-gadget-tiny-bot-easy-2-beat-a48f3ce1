// Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana.
// A two-tier mean-reversion paper-trading bot for the bars-replay/v1 harness.
// hello: each batch of orders answers one bar of closes.
//
// Strategy, per symbol, all from its own hourly closes:
//   - Track SMA(24) of closes (needs 24 bars of history; nothing trades before).
//   - Buy when the close dips below the SMA: a deep dip (2.5%) buys a full
//     slot (equity / 7), a shallow dip (1.2%) buys half a slot.
//   - Sell the whole position when the close recovers to the SMA.
//   - Never trade during warm-up batches; never hold more than the caps.
// Everything is a pure function of the bars: no clock, no randomness, so the
// two grading runs agree byte for byte.
import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SMA_SPAN = 24;
const SHALLOW_DIP = 0.012;
const DEEP_DIP = 0.025;
const FULL_SLOTS = 7n;
const MAX_SLIPPAGE_BPS = 100;

// Last closes per symbol, oldest first, capped at SMA_SPAN.
const closes = new Map<string, bigint[]>();

function sma(symbol: string): bigint | null {
  const arr = closes.get(symbol);
  if (arr === undefined || arr.length < SMA_SPAN) return null;
  let sum = 0n;
  for (const c of arr) sum += c;
  return sum / BigInt(arr.length);
}

await runBars({
  onBatch(state: BarsState) {
    // Fold this batch's closes into the histories first (warm-up included).
    for (const symbol of state.symbols.keys()) {
      const close = state.close(symbol);
      if (close === null) continue;
      const arr = closes.get(symbol) ?? [];
      arr.push(close);
      if (arr.length > SMA_SPAN) arr.shift();
      closes.set(symbol, arr);
    }
    // While warming up every order would be rejected: wait for the window.
    if (state.warmingUp) return [];
    const orders: (BuyInput | SellInput)[] = [];
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    for (const symbol of state.symbols.keys()) {
      const close = state.close(symbol);
      const m = sma(symbol);
      if (close === null || m === null) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined && held.qty > 0n) {
        // Holding: exit the whole position once the close is back at the SMA.
        if (close >= m) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }
      // Flat: buy the dip. Deep dip takes a full slot, shallow dip half.
      const full = state.equity / FULL_SLOTS;
      const room = state.weightRoom(symbol);
      let spend = 0n;
      if (close * 1000n < m * BigInt(Math.round((1 - DEEP_DIP) * 1000))) {
        spend = full < room ? full : room;
      } else if (close * 1000n < m * BigInt(Math.round((1 - SHALLOW_DIP) * 1000))) {
        const half = full / 2n;
        spend = half < room ? half : room;
      }
      if (spend > state.cash) spend = state.cash;
      if (spend >= minNotional) {
        orders.push({ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    return orders;
  },
});
