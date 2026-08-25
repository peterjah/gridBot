import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createWalletClient, formatGwei, type Chain, type Hash, type WalletClient } from "viem";
import { base } from "viem/chains";
import { createTransport } from "./client.js";
import { logger } from "../utils/logger.js";

export interface Transactor {
  account: PrivateKeyAccount;
  walletClient: WalletClient;
  /**
   * Simulate, sign and broadcast a raw contract call, then wait for the
   * receipt and verify success. Returns the transaction hash.
   */
  send(client: import("./client.js").BotClient, label: string, to: `0x${string}`, data: `0x${string}`): Promise<Hash>;
}

/** Does this error mean the nonce we used was wrong? */
function isNonceError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("replacement transaction underpriced") ||
    message.includes("nonce too low") ||
    message.includes("already known") ||
    message.includes("nonce has already been used")
  );
}

export function createTransactor(privateKey: `0x${string}`, rpcUrls: string[]): Transactor {
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: createTransport(rpcUrls),
  });

  /**
   * Locally tracked nonce.
   *
   * Letting the node pick is not safe for back-to-back sends: after a receipt
   * arrives, the RPC may still report the pre-transaction pending nonce for a
   * moment, so the next call reuses it and the node rejects it as
   * "replacement transaction underpriced". Observed in production between
   * `decreaseLiquidity` and `collect`.
   */
  let nextNonce: number | null = null;

  /**
   * Sends are serialized. Two overlapping sends would allocate the same nonce
   * no matter how it is sourced.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    account,
    walletClient,

    send(client, label, to, data) {
      return serialize(() => sendOnce(client, label, to, data));
    },
  };

  async function sendOnce(
    client: import("./client.js").BotClient,
    label: string,
    to: `0x${string}`,
    data: `0x${string}`,
  ): Promise<Hash> {
      logger.debug("Tx: starting", { label, to, dataLength: data.length, from: account.address });

      // Simulation doubles as revert checking and gas estimation.
      try {
        await client.call({ account, to, data });
        logger.debug("Tx: simulation passed", { label });
      } catch (error) {
        logger.error("Tx: simulation FAILED (would revert)", {
          label,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // Gas + nonce visibility before signing.
      let gas = null;
      try {
        gas = await client.estimateGas({ account, to, data });
        logger.debug("Tx: gas estimated", { label, gas: gas.toString() });
      } catch (error) {
        logger.debug("Tx: explicit gas estimate unavailable (wallet client will estimate)", {
          label,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (nextNonce === null) {
        nextNonce = await client.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        });
        logger.debug("Tx: nonce synced from chain", { label, nonce: nextNonce });
      }

      let hash: Hash;
      try {
        hash = await walletClient.sendTransaction({
          chain: base satisfies Chain,
          account,
          to,
          data,
          nonce: nextNonce,
          ...(gas !== null ? { gas } : {}),
        });
      } catch (error) {
        if (!isNonceError(error)) {
          nextNonce = null; // unknown state; resync before the next attempt
          throw error;
        }
        // Our view of the nonce drifted. Resync from the chain and retry once.
        const resynced = await client.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        });
        logger.warn("Tx: nonce rejected, resyncing", {
          label,
          used: nextNonce,
          resynced,
        });
        nextNonce = resynced;
        hash = await walletClient.sendTransaction({
          chain: base satisfies Chain,
          account,
          to,
          data,
          nonce: nextNonce,
          ...(gas !== null ? { gas } : {}),
        });
      }
      nextNonce += 1;
      logger.debug("Tx: broadcast", { label, hash, nonce: nextNonce - 1 });

      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        logger.error("Tx: REVERTED on-chain", {
          label,
          hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
        });
        throw new Error(`Transaction ${label} reverted (${hash})`);
      }
      logger.info("Tx confirmed", {
        label,
        hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGwei: formatGwei(receipt.effectiveGasPrice),
      });
      return hash;
  }
}

export function getWalletAddress(transactor: Transactor): `0x${string}` {
  return transactor.account.address;
}
