/**
 * Linking a wallet from a page that has a browser wallet (MetaMask, Rabby, Coinbase Wallet, ...; EIP-1193):
 * ask the server for a Sign-In with Ethereum message, have the wallet sign it, send the signature back.
 * Signing is free and sends no transaction.
 */
import { api } from "./mine-core.ts";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
}

const provider = () => (window as unknown as { ethereum?: Eip1193 }).ethereum;

export const hasBrowserWallet = (): boolean => !!provider();

export const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The linked wallet's checksummed address. `auth` is the miner's token, or the extension's link code. */
export async function linkWallet(server: string, auth: { token: string | null; code?: string }, step?: (text: string) => void): Promise<string> {
  const eth = provider();
  if (!eth) throw new Error("no browser wallet found: install MetaMask, Rabby or Coinbase Wallet, or open this page in your wallet app's browser");
  try {
    step?.("approve the connection in your wallet");
    const [address] = await eth.request({ method: "eth_requestAccounts" });
    if (!address) throw new Error("the wallet shared no account");
    const { nonce, message } = await api(server, "/api/auth/nonce", auth.token, { address, code: auth.code });
    step?.("sign the message in your wallet (free, no transaction)");
    const data = `0x${Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    const signature = await eth.request({ method: "personal_sign", params: [data, address] });
    step?.("checking the signature");
    const { wallet } = await api(server, "/api/auth/verify", auth.token, { nonce, signature });
    return wallet;
  } catch (err) {
    // EIP-1193: 4001 is the user saying no in the wallet
    if ((err as { code?: number }).code === 4001) throw new Error("cancelled in the wallet");
    throw err;
  }
}
