import { createPublicClient, fallback, http, type Transport } from "viem";
import { base } from "viem/chains";

/** Build a transport that fails over across the given RPC endpoints. */
export function createTransport(rpcUrls: string[]): Transport {
  if (rpcUrls.length === 0) {
    throw new Error("No RPC URLs configured");
  }
  const transports = rpcUrls.map((url) => http(url));
  return transports.length === 1 ? transports[0]! : fallback(transports);
}

export function createClient(rpcUrls: string[]) {
  return createPublicClient({
    chain: base,
    transport: createTransport(rpcUrls),
  });
}

export type BotClient = ReturnType<typeof createClient>;
