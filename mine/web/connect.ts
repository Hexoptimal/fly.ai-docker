/**
 * /connect: link a wallet to a miner in a normal tab. From the extension it arrives as /connect#<link code>
 * (the extension can't reach a browser wallet itself); on this site it uses the miner token in localStorage.
 * The wallet is the one signed in on the compute pages; signing in happens here if it hasn't yet.
 */
import { API } from "./config.ts";
import { mountAccount, onAccount, requireWallet, sessionHeaders, sessionLost } from "./account.ts";
import { api } from "./mine-core.ts";
import { shortAddress } from "./wallet.ts";

const $ = (id: string) => document.getElementById(id)!;
const code = location.hash.slice(1);
let token: string | null = null;
try { token = localStorage.getItem("flymine.token"); } catch { /* private window */ }

const status = (text: string, kind?: "ok" | "bad") => {
  $("status").textContent = text;
  $("status").dataset.standing = kind === "ok" ? "ok" : kind === "bad" ? "zeroed" : "";
};

mountAccount();
$("which").textContent = code ? "the one in your fly.ai compute extension" : token ? "the one mining on this site" : "none yet";
if (!code && !token) {
  status("start mining on this site first, or open Connect wallet from the extension", "bad");
  ($("connect") as HTMLButtonElement).disabled = true;
}
onAccount((wallet) => {
  if (!$("connect").textContent?.startsWith("Linked")) $("connect").textContent = wallet ? `Link ${shortAddress(wallet)}` : "Sign in and link";
});

$("connect").addEventListener("click", async () => {
  const button = $("connect") as HTMLButtonElement;
  button.disabled = true;
  try {
    if (!(await requireWallet())) {
      button.disabled = false;
      return;
    }
    status("linking…");
    const { wallet } = await api(API, "/api/session/link", code ? null : token, code ? { code } : {}, sessionHeaders());
    history.replaceState(null, "", location.pathname); // the link code is spent
    status(`linked ${shortAddress(wallet)} ✓`, "ok");
    $("intro").textContent = code
      ? `Your extension's credit now goes to ${wallet}. You can close this tab.`
      : `Credit from this site's miner now goes to ${wallet}.`;
    button.textContent = "Linked";
  } catch (err) {
    status(sessionLost(err) ? "your sign-in expired: sign in again" : err instanceof Error ? err.message : String(err), "bad");
    button.disabled = false;
  }
});
