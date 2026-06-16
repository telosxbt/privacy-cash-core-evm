# HyperTrade — how it works (in plain terms)

> Trade spot on Hyperliquid **without anyone being able to link** your deposit to your withdrawal.
> You deposit USDC anonymously, the protocol buys BTC for you, and you claim that BTC later —
> with no way to connect the two.

---

## The idea in one sentence

It's a **mixer (like Tornado Cash) with a "trade" button bolted on**.
A classic mixer does: *deposit → withdraw* while breaking the link between the two.
HyperTrade does: *deposit USDC → buy BTC → withdraw BTC*, breaking the link across the **whole** chain.

---

## The coat-check analogy 🎟️

Picture a nightclub coat-check where **everyone deposits the exact same €5,000 bill**.

1. **You deposit €5,000.** You get a ticket. But **nobody sees that ticket** — you keep it secret in your pocket. (= your *commitment* + your *secret*)

2. Later you want to trade. You show a **magic proof**: *"I hold a valid ticket"* — without revealing which one. The attendant is convinced you really deposited, but **has no idea whether you arrived at 10pm or at 2am**. (= the *ZK proof*)

3. With your €5,000, the coat-check buys you **a standard-sized bar of BTC** (always the same weight, for everyone).

4. The coat-check stores the bar and gives you a **new secret ticket** — one **you chose yourself in advance**. This new ticket has **no relationship whatsoever** to the old one.

5. Whenever you like, you show a **second magic proof**: *"I hold a valid bar ticket"* — and you get your BTC, sent to any address you want.

The result: an observer sees *"someone deposited"* and *"someone withdrew BTC"*, but **can never link the two people**. As far as they can tell, it could be anyone among all the depositors.

---

## The question everyone asks

> "If I deposit 5,000 USDC, how does the system know I can withdraw 0.01 BTC? There has to be a link, right?"

**No. And that's the whole point.** Three things to understand:

### 1. The 0.01 BTC is NOT computed from your 5,000 USDC

The `0.01` is a **protocol constant** (`btcNoteDenom`). The rule is fixed in advance:

> **1 USDC note (fixed size) → exactly 0.01 BTC (fixed size).**

No proportionality, no "your specific amount". Everyone deposits the same, everyone receives the same. Any surplus (if BTC turns out cheaper than budgeted) goes to the protocol, not into your note.

### 2. The "link" isn't mathematical — YOU hold both secrets

The contract never ties your USDC note to your BTC note through any computation.
**You hold two secret tickets in your pocket:**

- 🎟️ **Secret A** = your USDC note (the one you deposited)
- 🎟️ **Secret B** = your BTC note (which **you make up yourself** before trading)

At trade time, in **a single transaction**, you do two things at once:
- *"I burn my USDC note"* (proof using secret A)
- *"register my future BTC note"* (secret B, brand new)

Secret B has **no relationship** to secret A. Nobody else knows both belong to you.

### 3. Two ZK proofs bracket a public "pivot"

```
   DEPOSIT                   TRADE (public pivot)                  WITHDRAWAL

 5,000 USDC                                                        0.01 BTC
   │                                                                 ▲
   │ USDC note (secret A)                                            │ BTC note (secret B)
   ▼                                                                 │
 [ USDC pool ] ──ZK proof #1──> [ HyperTrader ] ──buy──> [ BTC pool ] ──ZK proof #2──>
                  ▲                                                      ▲
                  │                                                      │
        hides WHICH deposit                                   hides WHICH note you
        you are spending                                      withdraw + to WHOM
```

- **ZK proof #1** hides *which* USDC deposit you spend (anonymous among all depositors).
- **ZK proof #2** (a separate, later transaction) hides *which* BTC note you withdraw and *to which address*.

In between there is a public moment (`initiateTrade`) where you can see "a USDC withdrawal + a BTC note creation". But because **both ends are anonymous**, neither the original depositor nor the final recipient can be linked.

---

## The 5 lifecycle steps

| Step | What happens | Function |
|---|---|---|
| **1. Deposit** | You deposit a **fixed** amount of USDC. The pool stores a *commitment*. You keep your secret/nullifier locally. | `usdcPool.transact` (standard Privacy Cash deposit) |
| **2. ZK action** | You prove you own a valid USDC note without revealing which one. The note is spent to the `HyperTrader`. | `initiateTrade(...)` |
| **3. Bridge to HyperCore** | The contract moves the USDC from HyperEVM to HyperCore (via Hyperliquid's native system address / CoreWriter mechanism). | `adapter.bridgeToCore` |
| **4. Spot trade** | The contract places a **BTC/USDC buy order** (IOC limit), fixed size, with a slippage cap, a deadline, and the ability to cancel (`cancelTrade`) or retry (`retryTrade`). | `adapter.placeSpotBuy` |
| **5. Private claim** | Once the BTC is bought, it comes back into the BTC pool and your pre-chosen BTC note is created. Later, you prove you own it and withdraw your BTC to any address. | `settleTrade` → later, a ZK proof on `btcPool` |

> **Funds are centralized:** all traded BTC returns to **the same contract** (`btcPool`),
> so every user can withdraw their BTC whenever they want.

---

## Why two contracts?

| Contract | Role | Analogy |
|---|---|---|
| **`HyperPrivacyPool`** | The ZK vault. Holds the funds, the Merkle tree, the nullifiers; verifies proofs. Knows nothing about trading. | The **coat-check room** |
| **`HyperTrader`** | The orchestrator. Drives the trade lifecycle and talks to HyperCore. Holds no private funds. | The **attendant** who goes to buy the bar |

We deploy **two pools**: one for USDC (the spend side), one for BTC (the withdrawal side).

**Why not one?** Because in the ZK circuit the asset is a *private* signal — the contract can't read on-chain "is this a USDC proof or a BTC proof?". If we mixed both into the same vault, we'd have to regenerate the whole proving system (a new *trusted setup* — heavy and risky). By splitting per asset, **we reuse the existing Groth16 verifier as-is.**

---

## ⚠️ The golden rule: everything is fixed-size

This is THE condition for the anonymity to hold.

If everyone deposited an arbitrary amount (5k, 7.3k, 12k…) and received a proportional amount of BTC,
then **the amount itself** would become the fingerprint that betrays the deposit ↔ withdrawal link.

So:
- ✅ the USDC pool is **fixed-size** (everyone deposits the same) ;
- ✅ the BTC note is **fixed-size** (`btcNoteDenom`) ;
- ✅ the residual (price improvement / unspent USDC) goes to the protocol, **not** into your note.

It's the classic mixer trade-off: you give up amount granularity, you gain **unlinkability**.

---

## What if the order doesn't fill?

- **`retryTrade`**: you re-submit the buy with a higher limit price (the USDC is already on HyperCore).
- **`cancelTrade`**: past the deadline, if nothing filled, the USDC comes back into the pool as a **fresh shielded note** (your `refundCommitment`). You lose nothing and your anonymity stays intact.

---

## In summary

- **HyperPrivacyPool** = the anonymity (one ZK vault per asset).
- **HyperTrader** = the execution (the HyperCore bridge + the trade logic).
- **The deposit↔withdrawal link does not exist on-chain**: you hold two independent secrets, and two ZK proofs hide both ends.
- **Everything is fixed-size**, otherwise the amount gives it all away.

For the technical details (contracts, CoreWriter encoding, trust model, tests), see [`HYPERTRADE.md`](./HYPERTRADE.md).
