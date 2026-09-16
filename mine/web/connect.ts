/**
 * /connect: link a wallet to a miner in a normal tab. From the extension it arrives as /connect#<link code>
 * (the extension can't reach a browser wallet itself); on this site it uses the miner token in localStorage.
 */
import { API } from "./config.ts";
import { hasBrowserWallet, linkWallet, shortAddress } from "./wallet.ts";

const $ = (id: string) => document.getElementById(id)!;
const code = location.hash.slice(1);
let token: string | null = null;
try { token = localStorage.getItem("flymine.token"); } catch { /* private window */ }

const status = (text: string, kind?: "ok" | "bad") => {
  $("status").textContent = text;
  $("status").dataset.standing = kind === "ok" ? "ok" : kind === "bad" ? "zeroed" : "";
};

$("which").textContent = code ? "the one in your fly.ai compute extension" : token ? "the one mining on this site" : "none yet";
if (!code && !token) {
  status("start mining on this site first, or open Connect wallet from the extension", "bad");
  ($("connect") as HTMLButtonElement).disabled = true;
} else if (!hasBrowserWallet()) {
  status("no browser wallet found: install MetaMask, Rabby or Coinbase Wallet, or open this page in your wallet app's browser", "bad");
}

$("connect").addEventListener("click", async () => {
  const button = $("connect") as HTMLButtonElement;
  button.disabled = true;
  try {
    const wallet = await linkWallet(API, code ? { token: null, code } : { token }, (text) => status(text));
    history.replaceState(null, "", location.pathname); // the link code is spent
    status(`linked ${shortAddress(wallet)} ✓`, "ok");
    $("intro").textContent = code
      ? `Your extension's credit now goes to ${wallet}. You can close this tab.`
      : `Credit from this site's miner now goes to ${wallet}.`;
    button.textContent = "Linked";
  } catch (err) {
    status(err instanceof Error ? err.message : String(err), "bad");
    button.disabled = false;
  }
});
