import { defineChain } from "viem";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";

/** Robinhood Chain mainnet. Chain id 4663 checked against the RPC on 2026-09-13. */
export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

export const FLYAI = "0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C" as const;
export const BUY_URL = `https://www.ponsfamily.com/launchpad/${FLYAI}`;

export const erc20 = [
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const wagmiConfig = createConfig({
  chains: [robinhood],
  connectors: [injected()],
  transports: { [robinhood.id]: http() },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
