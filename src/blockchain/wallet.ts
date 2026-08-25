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

export function createTransactor(privateKey: `0x${string}`, rpcUrls: string[]): Transactor {
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: createTransport(rpcUrls),
  });

  return {
    account,
    walletClient,

    async send(client, label, to, data) {
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

      const hash = await walletClient.sendTransaction({
        chain: base satisfies Chain,
        account,
        to,
        data,
        ...(gas !== null ? { gas } : {}),
      });
      logger.debug("Tx: broadcast", { label, hash });

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
    },
  };
}

export function getWalletAddress(transactor: Transactor): `0x${string}` {
  return transactor.account.address;
}
