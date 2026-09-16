/**
 * /claim: a wallet's monthly claims. The server hands over each claim's amount, proof and ready-made
 * calldata; this page reads MonthlyClaims through the public RPC (funded yet? claimed yet?) and sends the
 * claim transaction through the browser wallet.
 */
import { API } from "./config.ts";
import { api } from "./mine-core.ts";
import { shortAddress } from "./wallet.ts";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
}
interface Claim {
  month: string; month_id: number; points: number; amount: string; amount_wei: string;
  claim_data: string; has_claimed_data: string; month_data: string;
}
interface Claims {
  wallet: string; contract: string | null; chain_id: number; chain_name: string; rpc: string; explorer: string; token_symbol: string;
  claims: Claim[];
}

const $ = (id: string) => document.getElementById(id)!;
const eth = () => (window as unknown as { ethereum?: Eip1193 }).ethereum;
let account: string | null = null;
let data: Claims | null = null;

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(data!.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result;
}
const call = (to: string, input: string) => rpc("eth_call", [{ to, data: input }, "latest"]) as Promise<string>;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

async function connect(): Promise<void> {
  const wallet = eth();
  if (!wallet) {
    $("note").textContent = "No browser wallet found: install MetaMask, Rabby or Coinbase Wallet, or open this page in your wallet app's browser.";
    return;
  }
  try {
    [account] = await wallet.request({ method: "eth_requestAccounts" });
  } catch (err) {
    $("note").textContent = (err as { code?: number }).code === 4001 ? "Cancelled in the wallet." : String(err);
    return;
  }
  $("account").textContent = shortAddress(account!);
  $("account").title = account!;
  $("connect").textContent = "Refresh";
  await load();
}

async function load(): Promise<void> {
  if (!account) return;
  const [claims, current] = await Promise.all([
    api(API, `/api/claims?wallet=${account}`, null) as Promise<Claims>,
    api(API, "/api/month", null),
  ]);
  data = claims;
  if (claims.contract) {
    const link = $("contract-link") as HTMLAnchorElement;
    link.href = `${claims.explorer}/address/${claims.contract}#code`;
    link.textContent = claims.contract;
  }
  const mine = current.wallets.find((w: { wallet: string }) => w.wallet.toLowerCase() === account!.toLowerCase());
  const ends = `ends in ${current.days_left} day${current.days_left === 1 ? "" : "s"}`;
  $("this-month").textContent = mine
    ? [
      `${fmt(mine.points)} points · ${(mine.share * 100).toFixed(2)}%`,
      `#${mine.rank} of ${current.wallets.length}`,
      current.announced_pool ? `≈ ${fmt(Number(current.announced_pool) * mine.share)} $FLYAI at this share` : null,
      ends,
    ].filter(Boolean).join(" · ")
    : `no points in ${current.month} yet · ${ends}`;

  if (!claims.claims.length) {
    $("note").textContent = "Nothing to claim yet. A month becomes claimable after it ends and its pool is set.";
    $("claims").replaceChildren();
    return;
  }
  $("note").textContent = claims.contract ? "" : "The claims contract isn't live yet; these amounts become claimable once it is.";
  $("claims").replaceChildren(...claims.claims.map((c) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<div><b class="month"></b> <span class="meta"></span></div><div class="amount"></div><div class="state">checking…</div>`;
    (row.querySelector(".month") as HTMLElement).textContent = c.month;
    (row.querySelector(".meta") as HTMLElement).textContent = `${fmt(c.points)} points`;
    (row.querySelector(".amount") as HTMLElement).textContent = `${Number(c.amount).toLocaleString("en-US", { maximumFractionDigits: 4 })} $${claims.token_symbol}`;
    void showState(c, row.querySelector(".state") as HTMLElement);
    return row;
  }));
}

async function showState(c: Claim, el: HTMLElement): Promise<void> {
  const d = data!;
  if (!d.contract) {
    el.textContent = "not claimable yet";
    return;
  }
  try {
    const month = await call(d.contract, c.month_data);
    if (/^0x0*$/.test(month.slice(0, 66))) {
      el.textContent = "waiting for this month to be funded";
      return;
    }
    if (BigInt(await call(d.contract, c.has_claimed_data)) === 1n) {
      el.textContent = "claimed ✓";
      el.dataset.standing = "ok";
      return;
    }
    el.replaceChildren();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn red sm";
    button.textContent = "Claim";
    button.addEventListener("click", () => void claim(c, el, button));
    el.append(button);
  } catch (err) {
    el.textContent = `can't read the chain: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function claim(c: Claim, el: HTMLElement, button: HTMLButtonElement): Promise<void> {
  const d = data!;
  const wallet = eth()!;
  button.disabled = true;
  const say = (text: string) => { button.textContent = text; };
  try {
    const chainId = `0x${d.chain_id.toString(16)}`;
    say("switching network…");
    try {
      await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (err) {
      if ((err as { code?: number }).code !== 4902) throw err; // 4902: the wallet doesn't know the chain yet
      await wallet.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId, chainName: d.chain_name, rpcUrls: [d.rpc], blockExplorerUrls: [d.explorer], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }],
      });
    }
    say("confirm in your wallet…");
    const hash: string = await wallet.request({ method: "eth_sendTransaction", params: [{ from: account, to: d.contract, data: c.claim_data }] });
    say("waiting for the chain…");
    for (let i = 0; i < 120; i++) {
      const receipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (receipt) {
        if (receipt.status !== "0x1") throw new Error("the claim transaction failed");
        el.innerHTML = `claimed ✓ <a target="_blank" rel="noopener"></a>`;
        el.dataset.standing = "ok";
        const link = el.querySelector("a")!;
        link.href = `${d.explorer}/tx/${hash}`;
        link.textContent = "view transaction";
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("no receipt after 4 minutes; check your wallet's activity");
  } catch (err) {
    button.disabled = false;
    button.textContent = "Claim";
    const note = document.createElement("div");
    note.className = "meta";
    note.dataset.standing = "zeroed";
    note.textContent = (err as { code?: number }).code === 4001 ? "cancelled in the wallet" : err instanceof Error ? err.message : String(err);
    el.append(note);
  }
}

$("connect").addEventListener("click", () => void (account ? load() : connect()));
