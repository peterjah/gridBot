import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createWalletClient, type Chain, type Hash, type WalletClient } from "viem";
import { base } from "viem/chains";
import { createTransport } from "./client.js";

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
      // Simulation doubles as revert checking and gas estimation.
      await client.call({ account, to, data });

      const hash = await walletClient.sendTransaction({
        chain: base satisfies Chain,
        account,
        to,
        data,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`Transaction ${label} reverted (${hash})`);
      }
      return hash;
    },
  };
}

export function getWalletAddress(transactor: Transactor): `0x${string}` {
  return transactor.account.address;
}
