import { describe, expect, it } from "vitest";
import {
  planLendingActions,
  withdrawShortfall,
  type LendingConfig,
} from "../src/lending/policy.js";

const cfg: LendingConfig = {
  bufferUsdcUsd: 500,
  bufferEth: 0.02,
  minActionUsd: 100,
};

describe("planLendingActions", () => {
  it("supplies idle USDC above the buffer", () => {
    const actions = planLendingActions(
      cfg,
      { usdcWallet: 9500, usdcLent: 0, ethWallet: 0, ethLent: 0 },
      4000,
    );
    expect(actions).toEqual([{ asset: "USDC", kind: "supply", amount: 9000, amountUsd: 9000 }]);
  });

  it("supplies idle WETH above the buffer, valued at current price", () => {
    const actions = planLendingActions(
      cfg,
      { usdcWallet: 400, usdcLent: 0, ethWallet: 1.02, ethLent: 0 },
      4000,
    );
    // 1.02 - 0.02 = 1 ETH surplus = $4000 >= minAction
    expect(actions).toContainEqual({
      asset: "WETH",
      kind: "supply",
      amount: 1,
      amountUsd: 4000,
    });
    // USDC below buffer with nothing lent -> no action
    expect(actions.filter((a) => a.asset === "USDC")).toHaveLength(0);
  });

  it("withdraws when wallet falls below the buffer and funds are lent", () => {
    const actions = planLendingActions(
      cfg,
      { usdcWallet: 200, usdcLent: 8000, ethWallet: 0, ethLent: 0 },
      4000,
    );
    expect(actions).toContainEqual({
      asset: "USDC",
      kind: "withdraw",
      amount: 300,
      amountUsd: 300,
    });
  });

  it("never proposes actions smaller than minActionUsd (gas churn guard)", () => {
    // Surplus of $50 < $100 -> nothing.
    expect(
      planLendingActions(cfg, { usdcWallet: 550, usdcLent: 0, ethWallet: 0, ethLent: 0 }, 4000),
    ).toHaveLength(0);

    // Deficit of $50 -> nothing.
    expect(
      planLendingActions(cfg, { usdcWallet: 450, usdcLent: 8000, ethWallet: 0, ethLent: 0 }, 4000),
    ).toHaveLength(0);

    // ETH surplus worth $80 < $100 -> nothing.
    expect(
      planLendingActions(cfg, { usdcWallet: 400, usdcLent: 0, ethWallet: 0.04, ethLent: 0 }, 2000),
    ).toHaveLength(0);
  });

  it("caps withdrawals at the lent balance", () => {
    const actions = planLendingActions(
      cfg,
      { usdcWallet: 0, usdcLent: 120, ethWallet: 0, ethLent: 0 },
      4000,
    );
    expect(actions).toContainEqual({
      asset: "USDC",
      kind: "withdraw",
      amount: 120,
      amountUsd: 120,
    });
  });

  it("does nothing when everything is within buffers", () => {
    const actions = planLendingActions(
      cfg,
      { usdcWallet: 500, usdcLent: 0, ethWallet: 0.02, ethLent: 0 },
      4000,
    );
    expect(actions).toHaveLength(0);
  });
});

describe("withdrawShortfall", () => {
  it("returns null when the wallet already has enough", () => {
    expect(withdrawShortfall(1000, 5000, 500)).toBeNull();
  });

  it("returns null when nothing is lent", () => {
    expect(withdrawShortfall(10, 0, 500)).toBeNull();
  });

  it("covers exactly the shortfall", () => {
    expect(withdrawShortfall(300, 5000, 1000)).toBeCloseTo(700);
  });

  it("caps at the lent balance when the shortfall exceeds it", () => {
    expect(withdrawShortfall(100, 250, 1000)).toBeCloseTo(250);
  });
});
