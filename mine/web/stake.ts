/**
 * /stake: stake and unstake $FLYAI in FlyStaking from the signed-in wallet (account.ts). Reads go through the public
 * RPC; writes are approve / stake / requestUnstake / cancelUnstake / withdraw, with selectors from the server.
 */
import { API } from "./config.ts";
import { errorText, mined, mountAccount, onAccount, requireWallet, transact } from "./account.ts";
import { api } from "./mine-core.ts";
import { shortAddress } from "./wallet.ts";

interface Config {
  contract: string | null; token: string; rpc: string; explorer: string; chain_id: number; chain_name: string; token_symbol: string;
  tiers: { name: string; min: string; multiplier: number }[];
  selectors: Record<"stake" | "requestUnstake" | "cancelUnstake" | "withdraw" | "stakedOf" | "unstaking" | "cooldown" | "totalStaked" | "approve" | "allowance" | "balanceOf", string>;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const WEI = 10n ** 18n;
let config: Config;
let account: string | null = null;

const word = (v: bigint | string) => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase().padStart(64, "0") : v.toString(16).padStart(64, "0"));
const data = (selector: string, ...args: (bigint | string)[]) => selector + args.map(word).join("");

function toWei(text: string): bigint {
  const m = /^(\d*)(?:\.(\d{0,18}))?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2])) throw new Error("enter an amount");
  return BigInt(m[1] || "0") * WEI + BigInt((m[2] ?? "").padEnd(18, "0"));
}
function tokens(wei: bigint): string {
  const whole = wei / WEI;
  const frac = (wei % WEI).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""} ${config.token_symbol}`;
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(config.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result;
}
const read = (to: string, input: string) => rpc("eth_call", [{ to, data: input }, "latest"]) as Promise<string>;
const words = (hex: string) => (hex.slice(2).match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`));

function tierFor(staked: bigint) {
  let found: Config["tiers"][number] | null = null;
  for (const t of config.tiers) if (staked >= BigInt(t.min) * WEI) found = t;
  return found;
}

/** Everyone's stake, shown whether or not a wallet is signed in. Tokens waiting to unstake don't count. */
async function refreshTotal(): Promise<void> {
  if (!config.contract) return;
  $("total").textContent = tokens(BigInt(await read(config.contract, config.selectors.totalStaked ?? "0x817b1cd2")));
}

async function refresh(): Promise<void> {
  void refreshTotal().catch(() => {});
  if (!account || !config.contract) return;
  const [staked, unstaking, balance, cooldown] = await Promise.all([
    read(config.contract, data(config.selectors.stakedOf, account)),
    read(config.contract, data(config.selectors.unstaking, account)),
    read(config.token, data(config.selectors.balanceOf, account)),
    read(config.contract, config.selectors.cooldown),
  ]);
  const s = BigInt(staked);
  const [pending, unlocksAt] = words(unstaking);
  const tier = tierFor(s);
  $("staked").textContent = tokens(s);
  $("tier").textContent = tier ? `${tier.name} · ${tier.multiplier}× points` : "below the first tier: no points";
  $("balance").textContent = tokens(BigInt(balance));
  $("cooldown").textContent = `${Number(BigInt(cooldown)) / 86_400} days`;
  $("pending").hidden = pending === 0n;
  if (pending > 0n) {
    $("pending-amount").textContent = tokens(pending);
    const unlocked = Date.now() / 1000 >= Number(unlocksAt);
    $("unlocks").textContent = unlocked ? "now" : new Date(Number(unlocksAt) * 1000).toLocaleString();
    $<HTMLButtonElement>("withdraw").disabled = !unlocked;
  }
}

/** One transaction from the signed-in wallet (the wallet is moved to the staking chain first), then its receipt. */
async function send(to: string, input: string, label: string): Promise<void> {
  delete $("tx").dataset.standing;
  const hash = await transact(to, input, (text) => { $("tx").textContent = `${label}: ${text}`; });
  $("tx").textContent = `${label}: waiting for the chain…`;
  try {
    await mined(hash);
  } catch (err) {
    throw new Error(`${label}: ${errorText(err)}`);
  }
  $("tx").innerHTML = `${label} done ✓ <a target="_blank" rel="noopener"></a>`;
  const link = $("tx").querySelector("a")!;
  link.href = `${config.explorer}/tx/${hash}`;
  link.textContent = "view transaction";
}

/** Runs one user action with the buttons disabled and any error shown. */
async function act(fn: () => Promise<void>): Promise<void> {
  const buttons = ["stake", "unstake", "withdraw", "cancel"].map((id) => $<HTMLButtonElement>(id));
  const was = buttons.map((b) => b.disabled);
  buttons.forEach((b) => { b.disabled = true; });
  try {
    account = await requireWallet(); // the buttons show before anyone signs in
    if (!account) return;
    await fn();
  } catch (err) {
    $("tx").dataset.standing = "zeroed";
    $("tx").textContent = errorText(err);
  } finally {
    buttons.forEach((b, i) => { b.disabled = was[i]; });
    await refresh().catch(() => {});
  }
}

async function boot(): Promise<void> {
  config = await api(API, "/api/stake-config", null);
  $("tiers").replaceChildren(...config.tiers.map((t) => {
    const tr = document.createElement("tr");
    for (const text of [t.name, `${BigInt(t.min).toLocaleString("en-US")}+ $${config.token_symbol}`, `${t.multiplier}×`]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    return tr;
  }));
  if (config.contract) {
    const link = $<HTMLAnchorElement>("contract-link");
    link.href = `${config.explorer}/address/${config.contract}#code`;
    link.textContent = config.contract;
    void refreshTotal().catch(() => { $("total").textContent = "—"; });
  }
  if (!config.contract) $("note").textContent = "Staking isn't live yet. Until it is, every miner's points count 1×.";

  mountAccount();
  onAccount((wallet) => {
    account = wallet;
    $("account").textContent = wallet ? shortAddress(wallet) : "not signed in";
    $("account").title = wallet ?? "";
    $("connect").textContent = wallet ? "Refresh" : "Sign in";
    for (const id of ["staked", "tier", "balance"]) $(id).textContent = "—";
    $("pending").hidden = true;
    void refresh().catch((err) => { $("note").textContent = errorText(err); });
  });
  $("connect").addEventListener("click", () => void (account ? refresh() : requireWallet()));
  $("stake").addEventListener("click", () => void act(async () => {
    const amount = toWei($<HTMLInputElement>("amount").value);
    const allowance = BigInt(await read(config.token, data(config.selectors.allowance, account!, config.contract!)));
    if (allowance < amount) await send(config.token, data(config.selectors.approve, config.contract!, amount), "Approve");
    await send(config.contract!, data(config.selectors.stake, amount), "Stake");
  }));
  $("unstake").addEventListener("click", () => void act(async () => {
    const amount = toWei($<HTMLInputElement>("amount").value);
    // a second request restarts the cooldown for everything already waiting
    if (!$("pending").hidden && !confirm(`You already have ${$("pending-amount").textContent} waiting to unstake. Unstaking more restarts the cooldown for all of it. Continue?`)) return;
    await send(config.contract!, data(config.selectors.requestUnstake, amount), "Unstake");
  }));
  $("withdraw").addEventListener("click", () => void act(() => send(config.contract!, config.selectors.withdraw, "Withdraw")));
  $("cancel").addEventListener("click", () => void act(() => send(config.contract!, config.selectors.cancelUnstake, "Stake again")));
}

void boot();
