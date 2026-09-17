/**
 * wagmi for the compute pages, bundled by build.mjs into web/wallet/kit.js (the pages themselves are plain modules
 * with no bundler). Browser wallets are found through EIP-6963, and phones reach a wallet app through WalletConnect
 * when a project id is set. wagmi keeps its connection under the same localStorage key as Flybook, so a wallet
 * connected on one is still connected on the other.
 */
import {
  connect as wagmiConnect, createConfig, disconnect as wagmiDisconnect, getConnectors, http, reconnect,
  sendTransaction, signMessage, switchChain, switchConnection, waitForTransactionReceipt, watchConnection, type Connector,
} from "@wagmi/core";
import { injected, walletConnect } from "@wagmi/connectors";
import { defineChain, type Hex } from "viem";

export interface WalletOption { uid: string; name: string; icon: string | null; kind: "browser" | "walletconnect" }
export interface Connection { address: string; chainId: number | undefined; wallet: string }
/** The server's chain (Robinhood Chain in production, anvil in tests), from /api/orders/config. */
export interface ChainInfo { chain_id: number; chain_name: string; rpc: string; explorer: string }

let config: ReturnType<typeof createConfig> | null = null;
let chain: ReturnType<typeof defineChain>;

/** Once per page; resolves once a wallet connected earlier is back. Without a WalletConnect project id only wallets inside this browser are offered. */
export async function setup(opts: { chain: ChainInfo; walletConnectProjectId?: string; url: string; icon: string }): Promise<void> {
  if (config) return;
  chain = defineChain({
    id: opts.chain.chain_id,
    name: opts.chain.chain_name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [opts.chain.rpc] } },
    blockExplorers: { default: { name: "Explorer", url: opts.chain.explorer } },
  });
  const connectors = [injected()];
  if (opts.walletConnectProjectId) {
    connectors.push(walletConnect({
      projectId: opts.walletConnectProjectId,
      showQrModal: true,
      metadata: { name: "fly.ai compute", description: "Run the fruit-fly connectome, buy compute, stake and claim $FLYAI.", url: opts.url, icons: [opts.icon] },
    }) as unknown as ReturnType<typeof injected>);
  }
  config = createConfig({
    chains: [chain],
    connectors,
    transports: { [chain.id]: http(undefined, { timeout: 15_000, retryCount: 1 }) },
  });
  // reconnect asks each wallet in turn and waits for its answer, and a broken extension never answers (two wallet
  // extensions wrapping each other's window.ethereum recurse forever). Don't let that hold up the page.
  await Promise.race([reconnect(config).catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
}

const cfg = () => {
  if (!config) throw new Error("wallet kit used before setup()");
  return config;
};

/** Wallets to offer: each one the browser announced, else the generic injected one, then WalletConnect. */
export function wallets(): WalletOption[] {
  const all = getConnectors(cfg());
  const announced = all.filter((c) => c.type === "injected" && c.id !== "injected");
  const browser = announced.length ? announced : all.filter((c) => c.id === "injected" && hasInjected());
  return [
    ...browser.map((c) => ({ uid: c.uid, name: c.id === "injected" ? "Browser wallet" : c.name, icon: c.icon ?? null, kind: "browser" as const })),
    ...all.filter((c) => c.type === "walletConnect").map((c) => ({ uid: c.uid, name: "WalletConnect", icon: null, kind: "walletconnect" as const })),
  ];
}

const hasInjected = () => typeof window !== "undefined" && !!(window as unknown as { ethereum?: unknown }).ethereum;

/**
 * The wallet in use. Read from the connections themselves, not wagmi's status: a wallet extension that never answers
 * leaves the status at "connecting" forever, even while another wallet is connected and working.
 */
export function connection(): Connection | null {
  const { current, connections } = cfg().state;
  const c = current ? connections.get(current) : undefined;
  return c?.accounts[0] ? { address: c.accounts[0], chainId: c.chainId, wallet: c.connector.name } : null;
}

export function onConnection(fn: (c: Connection | null) => void): () => void {
  return watchConnection(cfg(), { onChange: () => fn(connection()) });
}

/** Connects the chosen wallet (a no-op when it's already the one connected) and returns the account. */
export async function connect(uid: string): Promise<Connection> {
  const connector = getConnectors(cfg()).find((c: Connector) => c.uid === uid);
  if (!connector) throw new Error("that wallet isn't available any more; reload the page");
  const { current, connections } = cfg().state;
  // already connected (maybe by reconnect): use it; wagmi refuses to connect a connector twice
  if (connections.has(uid)) {
    if (current !== uid) await switchConnection(cfg(), { connector });
  } else {
    await wagmiConnect(cfg(), { connector, chainId: chain.id });
  }
  const c = connection();
  if (!c) throw new Error("the wallet shared no account");
  return c;
}

export async function disconnect(): Promise<void> {
  if (connection()) await wagmiDisconnect(cfg());
}

export async function sign(message: string): Promise<string> {
  return signMessage(cfg(), { message });
}

/** One transaction on the server's chain (the wallet is switched there first, adding the chain if it must). */
export async function send(to: string, data: string): Promise<string> {
  if (connection()?.chainId !== chain.id) await switchChain(cfg(), { chainId: chain.id });
  return sendTransaction(cfg(), { to: to as Hex, data: data as Hex, chainId: chain.id });
}

/** Resolves when the transaction is mined; throws if it reverted. */
export async function receipt(hash: string): Promise<void> {
  const r = await waitForTransactionReceipt(cfg(), { hash: hash as Hex, chainId: chain.id, timeout: 240_000 });
  if (r.status !== "success") throw new Error("the transaction failed on-chain");
}
