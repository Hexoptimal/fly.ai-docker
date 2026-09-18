/**
 * /claim: a wallet's monthly claims. The server hands over each claim's amount, proof and ready-made
 * calldata; this page reads MonthlyClaims through the public RPC (funded yet? claimed yet?) and sends the
 * claim transaction from the signed-in wallet (account.ts).
 */
import { API } from "./config.ts";
import { compact } from "./format.ts";
import { errorText, mined, mountAccount, onAccount, requireWallet, transact } from "./account.ts";
import { api } from "./mine-core.ts";
import { shortAddress } from "./wallet.ts";

interface Claim {
  month: string; month_id: number; points: number; amount: string; amount_wei: string;
  claim_data: string; has_claimed_data: string; month_data: string;
}
interface Claims {
  wallet: string; contract: string | null; chain_id: number; chain_name: string; rpc: string; explorer: string; token_symbol: string;
  claims: Claim[];
}

const $ = (id: string) => document.getElementById(id)!;
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
  showMonth(current);

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
    (row.querySelector(".amount") as HTMLElement).textContent = `${compact(Number(c.amount))} $${claims.token_symbol}`;
    void showState(c, row.querySelector(".state") as HTMLElement);
    return row;
  }));
}

/** The running month for this wallet: points, rank, and its share of the pool as it stands (buyers' orders grow it). */
function showMonth(current: { month: string; days_left: number; announced_pool: string | null; wallets: { wallet: string; points: number; share: number; rank: number }[] }): void {
  const mine = current.wallets.find((w) => w.wallet.toLowerCase() === account!.toLowerCase());
  const ends = `ends in ${current.days_left} day${current.days_left === 1 ? "" : "s"}`;
  $("this-month").textContent = mine
    ? [
      `${fmt(mine.points)} points · ${(mine.share * 100).toFixed(2)}%`,
      `#${mine.rank} of ${current.wallets.length}`,
      current.announced_pool ? `≈ ${compact(Number(current.announced_pool) * mine.share)} $FLYAI at this share` : null,
      ends,
    ].filter(Boolean).join(" · ")
    : `no points in ${current.month} yet · ${ends}`;
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
  button.disabled = true;
  const say = (text: string) => { button.textContent = text; };
  try {
    const hash = await transact(d.contract!, c.claim_data, say);
    say("waiting for the chain…");
    await mined(hash);
    el.innerHTML = `claimed ✓ <a target="_blank" rel="noopener"></a>`;
    el.dataset.standing = "ok";
    const link = el.querySelector("a")!;
    link.href = `${d.explorer}/tx/${hash}`;
    link.textContent = "view transaction";
  } catch (err) {
    button.disabled = false;
    button.textContent = "Claim";
    const note = document.createElement("div");
    note.className = "meta";
    note.dataset.standing = "zeroed";
    note.textContent = errorText(err);
    el.append(note);
  }
}

mountAccount();
onAccount((wallet) => {
  account = wallet;
  $("account").textContent = wallet ? shortAddress(wallet) : "not signed in";
  $("account").title = wallet ?? "";
  $("connect").textContent = wallet ? "Refresh" : "Sign in";
  if (wallet) void load().catch((err) => { $("note").textContent = errorText(err); });
  else {
    $("claims").replaceChildren();
    $("this-month").textContent = "—";
    $("note").textContent = "Sign in to see your claims.";
  }
});
$("connect").addEventListener("click", () => void (account ? load() : requireWallet()));
// this month's pool grows as buyers' orders are charged
setInterval(() => { if (account && !document.hidden) void api(API, "/api/month", null).then(showMonth, () => {}); }, 60_000);
