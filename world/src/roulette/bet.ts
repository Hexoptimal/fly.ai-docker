/**
 * Fly Roulette's "Play for $FLYAI" panel: bets from the player's fly.ai balance against the house.
 *
 * The server plays bet games (mine/src/roulette.ts); this page shows them turn by turn through main.ts's show()
 * and afterwards checks them: the server's seed must hash to the commit shown before the bet, and replaying the
 * game from both seeds on this browser's own fly brains must give the same turns.
 *
 * Sign-in, wallet transactions and the API address are the compute site's own modules, loaded at run time from
 * /compute/ (the same account works on both). In local development the Vite dev server proxies /api, /compute
 * and /assets to a local mining server (world/vite.config.ts).
 */
import { deriveRng, setup, sha256Hex, type GameEvent, type Table } from "./game.ts";

interface Hooks {
  size(): number;
  champion(): number;
  playing(): boolean;
  names(): string[];
  color(seat: number): string;
  show(names: string[], pick: number, events: AsyncIterable<GameEvent>, result: (winner: number) => string): Promise<void>;
  replay(table: Table, rng: () => number, onTurn: (e: GameEvent) => boolean): Promise<boolean>;
  brainReady(): boolean;
}

/** The compute site's account module (mine/web/account.ts). */
interface Account {
  signedIn(): string | null;
  sessionHeaders(): Record<string, string>;
  onAccount(fn: (wallet: string | null) => void): void;
  signIn(): Promise<string | null>;
  signOut(): Promise<void>;
  transact(to: string, data: string, step?: (text: string) => void, chainId?: number): Promise<string>;
  mined(hash: string, chainId?: number): Promise<void>;
  errorText(err: unknown): string;
}

interface Config {
  on: boolean; paused: boolean; edge: number; min_bet: string; max_bet: string; max_day: string; max_payout: string;
  multipliers: Record<string, number>;
}
interface Me {
  wallet: string; balance: string; terms_accepted: boolean; day_staked: string; live_game: string | null;
  withdraw_request: { amount: string } | null;
  history: { id: string; flies: number; pick: number; stake: string; payout: string; status: string; won: boolean | null; created_at: number }[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const WEI = 10n ** 18n;

/** "12.5" -> wei; null if it isn't a plain positive amount */
function toWei(s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(s.trim());
  if (!m) return null;
  return BigInt(m[1]) * WEI + BigInt((m[2] ?? "").padEnd(18, "0"));
}
const fmt = (s: string | number) => Number(s).toLocaleString(undefined, { maximumFractionDigits: 2 });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]!);
const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function initBets(hooks: Hooks) {
  const card = $("bet-card"), offEl = $("bet-off"), outEl = $("bet-out"), inEl = $("bet-in");
  const balanceEl = $("bet-balance"), whoEl = $("bet-who"), stakeEl = $<HTMLInputElement>("bet-stake"), pickEl = $("bet-pick");
  const paysEl = $("bet-pays"), goBtn = $<HTMLButtonElement>("bet-go"), msgEl = $("bet-msg"), resultEl = $("bet-result");
  const historyEl = $("bet-history"), depositBox = $("bet-deposit-box"), withdrawBox = $("bet-withdraw-box");
  const termsDlg = $<HTMLDialogElement>("terms-dlg");

  let API = "";
  let acct: Account | null = null;
  let cfg: Config | null = null;
  let me: Me | null = null;
  let chain: { token: string; pay_to: string; chain_id: number } | null = null;
  let betting = false;

  const say = (text: string, bad = false) => { msgEl.textContent = text; msgEl.classList.toggle("bad", bad); };

  async function api(path: string, body?: unknown): Promise<any> {
    const res = await fetch(API + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(acct?.sessionHeaders() ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && acct?.signedIn()) {
      await acct.signOut();
      throw new ApiError(401, "your sign-in ran out; sign in again");
    }
    if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
    return data;
  }

  // ---- showing the panel -----------------------------------------------------------------------------
  function changed(): void {
    if (!cfg) return;
    const n = hooks.size();
    const mult = cfg.multipliers[String(n)] ?? 0;
    const stake = Number(stakeEl.value);
    const pick = hooks.champion();
    const names = hooks.names();
    pickEl.innerHTML = pick >= 0
      ? `on seat ${pick + 1} <span class="dot" style="background:${hooks.color(pick)}"></span> <span class="dim">(now ${esc(names[pick] ?? "")})</span>`
      : `<span class="dim">tap a fly to back its seat</span>`;
    paysEl.innerHTML = `${n} flies: a win pays <b>${mult}x</b>${stake > 0 ? ` = <b>${fmt(stake * mult)} FLYAI</b>` : ""}`;
    const bal = me ? Number(me.balance) : 0;
    const ready = !!acct?.signedIn() && !!me && cfg.on && !cfg.paused && pick >= 0 && stake > 0 && stake <= bal && !hooks.playing() && !betting && !me.live_game;
    goBtn.disabled = !ready;
    goBtn.title = !me ? "sign in first" : pick < 0 ? "pick a fly first" : stake > bal ? "more than your balance" : "";
  }

  function showMe(): void {
    const wallet = acct?.signedIn() ?? null;
    outEl.hidden = !!wallet;
    inEl.hidden = !wallet;
    if (!wallet || !me) { changed(); return; }
    whoEl.textContent = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
    balanceEl.textContent = `${fmt(me.balance)} FLYAI`;
    const wr = me.withdraw_request;
    $("bet-withdraw-note").textContent = wr ? `You asked for ${fmt(wr.amount)} FLYAI back; it's sent by hand, usually within a day.` : "";
    historyEl.innerHTML = me.history.length ? me.history.map((h) => `<li><span>${h.flies} flies · seat ${h.pick + 1} · ${fmt(h.stake)}</span>
      <b class="${h.won ? "won" : h.status === "done" ? "lost" : ""}">${h.status === "live" ? "playing" : h.status === "void" ? "refunded" : h.won ? `+${fmt(h.payout)}` : `−${fmt(h.stake)}`}</b></li>`).join("")
      : `<li class="dim">No bets yet.</li>`;
    changed();
  }

  async function refresh(): Promise<void> {
    if (!acct?.signedIn()) { me = null; showMe(); return; }
    try {
      me = await api("/api/roulette/me");
    } catch (err) {
      me = null;
      say(String((err as Error).message), true);
    }
    showMe();
  }

  // ---- terms --------------------------------------------------------------------------------------------
  function acceptTerms(): Promise<boolean> {
    const age = $<HTMLInputElement>("terms-18"), ok = $<HTMLInputElement>("terms-ok"), go = $<HTMLButtonElement>("terms-go");
    age.checked = ok.checked = false;
    go.disabled = true;
    const sync = () => { go.disabled = !(age.checked && ok.checked); };
    age.onchange = ok.onchange = sync;
    termsDlg.showModal();
    return new Promise((resolve) => {
      $("terms-cancel").onclick = () => { termsDlg.close(); resolve(false); };
      go.onclick = async () => {
        go.disabled = true;
        try {
          await api("/api/roulette/terms", { over18: true, accept: true });
          termsDlg.close();
          resolve(true);
        } catch (err) {
          $("terms-msg").textContent = String((err as Error).message);
          sync();
        }
      };
    });
  }

  // ---- a bet ----------------------------------------------------------------------------------------------
  /** The server's events for a game, as they're played: polled every second, until the end. */
  async function* events(id: string): AsyncGenerator<GameEvent> {
    let after = 0;
    for (;;) {
      const g = await api(`/api/roulette/games/${id}?after=${after}`);
      for (const e of g.events as (GameEvent & { seq: number })[]) {
        after = e.seq + 1;
        const { seq: _seq, ...event } = e;
        yield event as GameEvent;
        if (event.type === "end") return;
      }
      if (g.status === "void") throw new ApiError(500, "the server couldn't finish this game; your stake was refunded");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async function watch(game: any): Promise<void> {
    resultEl.hidden = true;
    const won = (winner: number) => winner === game.pick;
    await hooks.show(game.names, game.pick, events(game.id), (winner) => won(winner)
      ? `<small class="betwin">+${fmt(game.payout)} FLYAI to your balance</small>`
      : `<small class="betloss">−${fmt(game.stake)} FLYAI</small>`);
    const done = await api(`/api/roulette/games/${game.id}`);
    showResult(done);
    await refresh();
  }

  async function placeBet(): Promise<void> {
    if (!cfg || !me) return;
    betting = true;
    changed();
    try {
      if (!me.terms_accepted) {
        if (!(await acceptTerms())) return;
        me.terms_accepted = true;
      }
      say("locking in the server's seed…");
      const { commit_id, hash } = await api("/api/roulette/commit", {});
      $("bet-commit").textContent = hash;
      const game = await api("/api/roulette/games", {
        commit_id, client_seed: randomHex(16), flies: hooks.size(), pick: hooks.champion(), stake: stakeEl.value.trim(),
      });
      say("");
      await refresh();
      await watch(game);
    } catch (err) {
      say(String((err as Error).message), true);
      await refresh();
    } finally {
      betting = false;
      changed();
    }
  }

  // ---- after a game: show the seeds and let the player check it ---------------------------------------------
  let last: any = null;
  function showResult(g: any): void {
    last = g;
    resultEl.hidden = false;
    $("res-line").innerHTML = g.status === "void" ? "Refunded: the server couldn't finish this game."
      : g.won ? `You won <b>+${fmt(g.payout)} FLYAI</b>` : `You lost <b>${fmt(g.stake)} FLYAI</b>`;
    $("res-commit").textContent = g.commit_hash;
    $("res-server").textContent = g.server_seed ?? "not yet revealed";
    $("res-client").textContent = g.client_seed;
    $("res-verify-out").textContent = "";
    $<HTMLButtonElement>("res-verify").disabled = !g.server_seed;
  }

  async function verify(): Promise<void> {
    const g = last;
    if (!g?.server_seed) return;
    const out = $("res-verify-out");
    const btn = $<HTMLButtonElement>("res-verify");
    btn.disabled = true;
    try {
      if ((await sha256Hex(g.server_seed)) !== g.commit_hash) { out.textContent = "✗ the server seed doesn't match the commit"; return; }
      if (!hooks.brainReady()) { out.textContent = "the fly brains are still loading; try in a moment"; return; }
      const rng = await deriveRng(g.server_seed, g.client_seed);
      const table = setup(g.flies, rng);
      if (JSON.stringify(table.names) !== JSON.stringify(g.names)) { out.textContent = "✗ the table doesn't follow from the seeds"; return; }
      const theirs = (g.events as (GameEvent & { seq: number })[]).map(({ seq: _seq, ...e }) => JSON.stringify(e));
      let k = 0;
      out.textContent = "replaying on your own fly brains… 0 turns";
      const ok = await hooks.replay(table, rng, (e) => {
        const same = JSON.stringify(e) === theirs[k];
        k++;
        if (e.type === "turn") out.textContent = `replaying on your own fly brains… ${k} of ${theirs.length - 1} turns`;
        return same;
      });
      out.textContent = ok && k === theirs.length
        ? `✓ checked: the seed matches the commit, and all ${k - 1} turns replay the same on your own fly brains`
        : `✗ turn ${k} came out differently here (other browsers than Chrome may round differently)`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---- deposits and withdrawals -------------------------------------------------------------------------
  async function deposit(): Promise<void> {
    const amountEl = $<HTMLInputElement>("dep-amount"), status = $("dep-status");
    const wei = toWei(amountEl.value);
    if (!wei || wei <= 0n) { status.textContent = "enter an amount"; return; }
    if (!acct || !chain) return;
    const btn = $<HTMLButtonElement>("dep-go");
    btn.disabled = true;
    try {
      const data = `0xa9059cbb${chain.pay_to.slice(2).toLowerCase().padStart(64, "0")}${wei.toString(16).padStart(64, "0")}`;
      const tx = await acct.transact(chain.token, data, (t) => { status.textContent = t; }, chain.chain_id);
      status.textContent = "waiting for the transfer to be mined…";
      await acct.mined(tx, chain.chain_id);
      for (let i = 0; ; i++) {
        try {
          const r = await api("/api/balance/deposit", { tx });
          status.textContent = `✓ ${fmt(r.deposited)} FLYAI added`;
          break;
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 409 && /mined/.test(err.message)) || i > 20) throw err;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      amountEl.value = "";
      await refresh();
    } catch (err) {
      status.textContent = acct.errorText(err);
    } finally {
      btn.disabled = false;
    }
  }

  async function withdraw(): Promise<void> {
    const amountEl = $<HTMLInputElement>("wd-amount"), status = $("wd-status");
    if (!toWei(amountEl.value)) { status.textContent = "enter an amount"; return; }
    try {
      me = await api("/api/balance/withdraw-request", { amount: amountEl.value.trim() });
      status.textContent = "✓ asked; it's sent to your wallet by hand, usually within a day";
      amountEl.value = "";
      showMe();
    } catch (err) {
      status.textContent = String((err as Error).message);
    }
  }

  // ---- start ------------------------------------------------------------------------------------------------
  async function start(): Promise<void> {
    try {
      const config = await import(/* @vite-ignore */ new URL("/compute/mine/web/config.js", location.href).href);
      API = import.meta.env.DEV ? "" : config.API;
      cfg = await api("/api/roulette/config");
      if (!cfg!.on) { offEl.textContent = "Betting isn't open yet. Free play is on the table."; return; }
      acct = await import(/* @vite-ignore */ new URL("/compute/mine/web/account.js", location.href).href) as Account;
      const oc = await api("/api/orders/config").catch(() => null);
      if (oc?.pay_to) chain = { token: oc.token, pay_to: oc.pay_to, chain_id: oc.chain_id ?? oc.chain?.id };
    } catch {
      offEl.textContent = "Betting is out of reach right now; free play still works.";
      return;
    }
    offEl.hidden = true;
    card.classList.add("on");
    $("bet-limits").textContent = `Bets ${fmt(cfg!.min_bet)} to ${fmt(cfg!.max_bet)} FLYAI · up to ${fmt(cfg!.max_day)} a day · house edge ${Math.round(cfg!.edge * 100)}%`;
    if (cfg!.paused) say("Betting is paused for now; try again later.", true);
    stakeEl.value = cfg!.min_bet;
    acct.onAccount(() => void refresh());
    $("bet-signin").onclick = async () => {
      try { await acct!.signIn(); } catch (err) { say(acct!.errorText(err), true); }
      await refresh();
    };
    $("bet-signout").onclick = async () => { await acct!.signOut(); await refresh(); };
    stakeEl.oninput = changed;
    goBtn.onclick = () => void placeBet();
    $("bet-deposit").onclick = () => { depositBox.hidden = !depositBox.hidden; withdrawBox.hidden = true; };
    $("bet-withdraw").onclick = () => { withdrawBox.hidden = !withdrawBox.hidden; depositBox.hidden = true; };
    $("dep-go").onclick = () => void deposit();    $("wd-go").onclick = () => void withdraw();
    $("res-verify").onclick = () => void verify();
    await refresh();
    // a game still on the table from before a reload: watch it to the end
    if (me?.live_game && !hooks.playing()) {
      const g = await api(`/api/roulette/games/${me.live_game}`);
      void watch(g);
    }
  }
  void start();

  return { changed };
}
