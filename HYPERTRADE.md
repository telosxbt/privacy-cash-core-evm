# HyperTrade — Privacy-preserving spot trading on HyperEVM / HyperCore

This extends the Privacy Cash UTXO pool into an **anonymous spot-trading protocol**:
deposit USDC privately, trigger an unlinkable spot buy of BTC on HyperCore with a
ZK proof, and later claim the resulting BTC as a fresh private note.

It reuses the existing circuit and `Verifier2` **unchanged** — no new trusted setup.

## Contracts

| Contract | Role |
|---|---|
| `HyperPrivacyPool` | `ERCPool` + two controller hooks. One instance per asset (USDC pool, BTC pool). |
| `HyperTrader` | Orchestrates the trade lifecycle and links the two pools to HyperCore. |
| `hypercore/IHyperCore` | Mockable adapter interface for all HyperCore interaction. |
| `hypercore/HyperCoreAdapter` | Production adapter: CoreWriter (`0x333…3`) + read precompiles (`0x800…`) + EVM↔Core token system addresses. |
| `hypercore/CoreWriterLib` | Encodes CoreWriter actions (limit order, cancel-by-cloid, spot send). |
| `Mocks/MockHyperCore` | Deterministic simulator used by the tests. |

## Lifecycle

```
        deposit (USDC note)            ZK withdraw proof
 user ───────────────────▶ usdcPool ──────────────────▶ HyperTrader.initiateTrade
                                                              │  bridge USDC → HyperCore
                                                              │  CoreWriter IOC limit buy (size = btcNoteDenom, px ≤ limitPx)
                                                              ▼
                                                          HyperCore spot BTC/USDC
                                                              │
 HyperTrader.settleTrade ◀────────────────────────────────────┘
   bridge btcNoteDenom BTC → btcPool
   traderMint(BTC note)            user later: ZK withdraw proof on btcPool → BTC to any address
```

1. **Deposit** — `usdcPool.transact` (standard shielded deposit). Use fixed `min == max` for a fixed-size pool.
2. **ZK action** — `initiateTrade(proof, extData, params)`: the proof is a normal shielded
   withdrawal with `recipient = HyperTrader`. The pool checks the commitment is in the tree,
   the nullifier is unspent, the public amount, and verifies the Groth16 proof — the link to
   the depositor is broken exactly as in a normal withdrawal.
3. **HyperCore transfer** — the controller bridges the released USDC to HyperCore (token system
   address) and the funds are credited to the protocol's core account.
4. **Spot trade** — a CoreWriter **IOC limit buy** for a **fixed base size** (`btcNoteDenom`):
   - market buy → IOC at `limitPx`; limit buy → set `limitPx`;
   - **slippage protection** = `limitPx` (fill never exceeds it);
   - **min BTC received** = the fixed `size` (settle requires `coreBtc ≥ size`);
   - **deadline** + **cancel/retry** for unfilled orders (`cancelTrade` refunds, `retryTrade` re-prices).
5. **Private claim** — `settleTrade` bridges the BTC back into `btcPool` and `traderMint`s the
   user's pre-committed BTC note. The user proves ownership later via the standard circuit on
   `btcPool`, with no on-chain link to the USDC deposit that funded it.

All asset balances are centralised: USDC backing lives in `usdcPool`, BTC backing in `btcPool`,
both driven by the single `HyperTrader`.

## Why two pools instead of one tree

The circuit's `mintAddress` is a **private** signal, so the contract can't read which asset a
proof spends. Rather than regenerate the verifier to expose it, each asset gets its own pool
(tree + nullifier set). Soundness comes from proving against a specific pool's root; assets stay
isolated and the verifier is reused as-is.

## Fixed input + fixed output = unlinkability

Every trade spends a fixed-size USDC note and produces a fixed-size BTC note, so all trades look
identical on-chain. The cost: HyperCore residual (price improvement / unspent USDC) is **not**
folded into the private notes — it accrues to the protocol `coreAccount` and is swept by the
admin. This keeps every settlement amount deterministic (the user can commit to the exact BTC
note amount in advance, despite a market order).

## Trust model (read before mainnet)

- **`traderMint` is privileged.** The `HyperTrader` is trusted to mint a BTC/refund note only
  after the backing asset has actually been bridged into the pool. This is the same trust surface
  as the existing `admin` (which can already upgrade the UUPS proxy). The controller is
  deterministic and auditable; rotate it via `configureTrader` (admin-gated).
- **`HyperCoreAdapter` encodings are best-effort** against the public HyperEVM/CoreWriter spec.
  Precompile addresses and the system-address base are constructor-configurable so the spec can
  evolve without redeploying the pools. The protocol invariants are enforced in `HyperTrader`; the
  test suite exercises the same controller logic against `MockHyperCore`.
- **Decimals:** the mock treats EVM and core units 1:1; `HyperCoreAdapter` does real
  `evmDecimals ↔ coreDecimals` scaling. Register tokens with `registerToken` before use.

## Tests

`test/hyperTrade.test.js` (real Groth16 proofs):
- happy path: deposit USDC → shielded spot BTC buy → private BTC claim;
- slippage protection: no fill above limit, then `retryTrade` fills;
- cancel: unfilled past deadline refunds USDC as a shielded note;
- access control: only controller mints, only admin configures, recipient must be the controller.

```bash
yarn install
yarn compile
npx hardhat test test/hyperTrade.test.js
```
