import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useConnection } from "wagmi";
import { switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import type { Viewer } from "./Account";
import {
  deleteDesign, drawDesign, getClaim, getConfig, getMerchQuota, getMyMerch, payDesign,
  type Claim, type MerchDesign, type MerchProduct, type MerchQuota, type MyMerch,
} from "./api";
import {
  loadFlies, loadMerch, loadMerchAwards, loadMerchMonth, merchImage,
  type Fly, type MerchAward, type MerchItem, type MerchMonthRow,
} from "./feed";
import { FLYAI, erc20, robinhood, wagmiConfig } from "./wallet";

const SHOP = "https://shop.flyaiworld.com";
const COLLECTION = `${SHOP}/collections/fly-merch`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];
const usd = (x: number) => `$${x.toFixed(2)}`;
const tokens = (x: number) => Math.round(x).toLocaleString("en-US");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const LABEL: Record<string, string> = { tee: "Tee", hoodie: "Hoodie", mug: "Mug", sticker: "Sticker" };
const ICON: Record<string, string> = { tee: "👕", hoodie: "🧥", mug: "☕", sticker: "🏷️" };
const ORDER = ["tee", "hoodie", "mug", "sticker"];
const byKind = <T extends { kind: string }>(xs: T[]) => [...xs].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
const dayName = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long" });

// small per-browser memory: a payment sent but not yet accepted (so nobody pays twice), and launches already celebrated
function remember<T>(key: string): T | null {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
}
function keep(key: string, value: unknown) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
type Pending = { hash: `0x${string}`; kinds: string[] };
const pendingKey = (id: number) => `flybook-merch-pay-${id}`;
const seenKey = (id: number) => `flybook-merch-seen-${id}`;

/** Submit a sent payment to the API, retrying while the chain confirms it. */
async function submitPayment(id: number, p: Pending): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await payDesign(id, p.hash, p.kinds);
      keep(pendingKey(id), null);
      return;
    } catch (e) {
      if (!/isn't confirmed yet/.test(message(e)) || i >= 20) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function shareMerch(flyName: string, url: string) {
  const intent = new URL("https://twitter.com/intent/tweet");
  intent.searchParams.set("text", `My fly ${flyName} has its own merch now 🪰 A simulated fruit fly brain, on a shirt.`);
  intent.searchParams.set("url", url);
  window.open(intent.toString(), "_blank", "noopener,noreferrer");
}

/** Buy buttons: a mockup (when there is one), the product and its price. */
function Products({ products, big = false }: { products: MerchProduct[]; big?: boolean }) {
  return (
    <div className={`merch-buy${big ? " big" : ""}`}>
      {byKind(products).map((p) => (
        <a key={p.kind} className="merch-product" href={p.url ?? COLLECTION} target="_blank" rel="noreferrer">
          {p.image_url ? <img src={p.image_url} alt="" loading="lazy" /> : <span className="merch-icon">{ICON[p.kind]}</span>}
          <span>{LABEL[p.kind] ?? p.kind}</span>
          {p.price != null && <span className="mono">{usd(Number(p.price))}</span>}
        </a>
      ))}
    </div>
  );
}

const STEPS = ["Drawn", "Paid", "Printing", "On sale"] as const;
function Steps({ status }: { status: MerchDesign["status"] }) {
  const at = status === "draft" ? 0 : status === "paid" ? 1 : status === "making" || status === "failed" ? 2 : 3;
  return (
    <ol className="merch-steps" aria-label={`Step ${at + 1} of 4: ${STEPS[at]}`}>
      {STEPS.map((s, i) => (
        <li key={s} className={i < at || status === "live" ? "done" : i === at ? (status === "failed" ? "stuck" : "now") : ""}>{s}</li>
      ))}
    </ol>
  );
}

/** Shown once when a design goes on sale (and from its Share button): mockups, where to buy it, what the owner earns. */
function Launched({ design, flyName, quota, onClose }: {
  design: MerchDesign; flyName: string; quota: MerchQuota | null; onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const products = byKind(design.merch_products ?? []);
  const link = products.find((p) => p.kind === "tee")?.url ?? products[0]?.url ?? COLLECTION;
  const earn = new Map(quota?.products.map((p) => [p.kind, p.earn_each]) ?? []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { window.prompt("Copy this link", link); }
  };
  return createPortal(
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal merch-launched" role="dialog" aria-modal="true" aria-labelledby="launched-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-scroll">
          <p className="merch-kicker">🎉 It's live</p>
          <h3 id="launched-title">{flyName} merch is on sale</h3>
          <img className="merch-hero" src={design.preview_url} alt={`${flyName} design`} />
          <Products products={products} big />
          <div className="merch-earn-list">
            {products.filter((p) => earn.has(p.kind)).map((p) => (
              <span key={p.kind}>{LABEL[p.kind]}: you earn <b>{usd(earn.get(p.kind)!)}</b> a sale</span>
            ))}
          </div>
          <p className="fine">Earnings are paid to your wallet in $FLYAI at the end of each month. Share it: every sale pays you too.</p>
          <div className="row merch-actions">
            <button className="btn red" onClick={() => shareMerch(flyName, link)}>Post on X</button>
            <button className="btn" onClick={copy}>{copied ? "Link copied" : "Copy link"}</button>
            <a className="btn" href={link} target="_blank" rel="noreferrer">Open in shop</a>
            <button className="btn" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A draft's product toggles: which items it launches as (at least one), with price and the owner's cut. */
function KindPicker({ quota, kinds, onChange, disabled }: {
  quota: MerchQuota; kinds: string[]; onChange: (k: string[]) => void; disabled: boolean;
}) {
  const toggle = (k: string) => {
    const next = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
    if (next.length) onChange(next);
  };
  return (
    <div className="merch-kinds" role="group" aria-label="Products to launch">
      {quota.products.map((p) => {
        const on = kinds.includes(p.kind);
        return (
          <button key={p.kind} type="button" className={`merch-kind${on ? " on" : ""}`} aria-pressed={on} disabled={disabled}
                  onClick={() => toggle(p.kind)} title={on && kinds.length === 1 ? "Keep at least one" : undefined}>
            <span className="merch-kind-top"><span>{ICON[p.kind]} {p.label}</span><span className="merch-tick">{on ? "✓" : ""}</span></span>
            <span className="fine">from {usd(p.from)} · you earn {usd(p.earn_each)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The studio: draw a design of one of your flies, pick its products, pay, and track sales and earnings. */
function Studio({ mine, onLive }: { mine: Fly[]; onLive: () => void }) {
  const { address, chainId } = useConnection();
  const [quota, setQuota] = useState<MerchQuota | null>(null);
  const [data, setData] = useState<MyMerch | null>(null);
  const [flyId, setFlyId] = useState(mine[0]?.id ?? "");
  const [style, setStyle] = useState("sticker");
  const [idea, setIdea] = useState("");
  const [showName, setShowName] = useState(true);
  const [picks, setPicks] = useState<Record<number, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [launched, setLaunched] = useState<MerchDesign | null>(null);

  const refresh = () => {
    getMerchQuota().then(setQuota).catch((e) => setError(message(e)));
    getMyMerch().then(setData).catch((e) => setError(message(e)));
  };
  useEffect(refresh, []);
  useEffect(() => {   // flies load after the tab opens
    if (!mine.some((f) => f.id === flyId) && mine[0]) setFlyId(mine[0].id);
  }, [mine.map((f) => f.id).join(",")]);
  // products take a minute or two to make: check again while any design is being made
  const making = data?.designs.some((d) => d.status === "paid" || d.status === "making");
  useEffect(() => {
    if (!making) return;
    const t = setInterval(refresh, 8_000);
    return () => clearInterval(t);
  }, [making]);
  // celebrate a launch once: a design on sale for less than a day that this browser hasn't shown yet
  useEffect(() => {
    const fresh = data?.designs.find((d) => d.status === "live" && !remember(seenKey(d.id))
      && Date.now() - Date.parse(d.live_at ?? d.created_at) < 86_400_000);
    if (fresh && !launched) {
      setLaunched(fresh);
      onLive();
    }
  }, [data]);
  const closeLaunched = () => {
    if (launched) keep(seenKey(launched.id), true);
    setLaunched(null);
  };

  const allKinds = quota?.products.map((p) => p.kind) ?? ORDER;
  const kindsOf = (d: MerchDesign) => picks[d.id] ?? remember<Pending>(pendingKey(d.id))?.kinds ?? allKinds;

  const draw = async () => {
    setBusy("draw");
    setError(null);
    setNote(null);
    try {
      const d = await drawDesign({ fly_id: flyId, style, idea: idea.trim() || undefined, show_name: showName });
      if (showName && d.name_printed === false) setNote("We left the name off this one: it looked like a brand or a famous name.");
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const pay = async (d: MerchDesign) => {
    if (!quota) return;
    setBusy(`pay-${d.id}`);
    setError(null);
    try {
      let pending = remember<Pending>(pendingKey(d.id));
      if (!pending) {
        if (!address) throw new Error("Connect your wallet first.");
        if (quota.wallet && address.toLowerCase() !== quota.wallet) {
          throw new Error(`Pay from the wallet you signed in with (${short(quota.wallet)}).`);
        }
        if (chainId !== robinhood.id) await switchChain(wagmiConfig, { chainId: robinhood.id });
        const hash = await writeContract(wagmiConfig, {
          address: FLYAI, abi: erc20, functionName: "transfer", chainId: robinhood.id,
          args: [quota.treasury, BigInt(quota.fee_wei)],
        });
        pending = { hash, kinds: kindsOf(d) };
        keep(pendingKey(d.id), pending);
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: robinhood.id });
      }
      await submitPayment(d.id, pending);
      refresh();
    } catch (e) {
      const m = message(e);
      setError(/rejected|denied/i.test(m) ? "Payment cancelled." : m);
      if (/already paid|before this design|sends no \$FLYAI|failed on chain/.test(m)) keep(pendingKey(d.id), null);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (d: MerchDesign) => {
    if (!window.confirm("Delete this design?")) return;
    try {
      await deleteDesign(d.id);
      refresh();
    } catch (e) {
      setError(message(e));
    }
  };

  const flyName = (id: string) => mine.find((f) => f.id === id)?.name ?? "your fly";
  const blocked = !quota || !quota.holder || quota.left_today < 1 || quota.global_left < 1 || !flyId;
  const asTokens = (x: number) => (data?.flyai_usd ? `${tokens(x / data.flyai_usd)} $FLYAI` : usd(x));
  return (
    <section className="merch-studio">
      {data && data.designs.some((d) => d.status === "live") && (
        <div className="merch-payout">
          <div>
            <span className="fine">Coming to you on {dayName(data.payout_date)}</span>
            <span className="merch-payout-big mono">
              {data.unpaid_tokens != null ? `${tokens(data.unpaid_tokens)} $FLYAI` : usd(data.unpaid)}
            </span>
            <span className="fine">
              {data.unpaid_tokens != null && `${usd(data.unpaid)} at today's price · `}
              {Math.round(data.share * 100)}% of the profit on every sale
            </span>
          </div>
          <div className="merch-payout-side">
            <span><b className="mono">{usd(data.earned)}</b> earned</span>
            <span><b className="mono">{usd(data.paid)}</b> paid out</span>
          </div>
        </div>
      )}

      <h3>Make merch of your fly</h3>
      {!mine.length && <p className="fine">Hatch a fly first, then come back and put it on a shirt.</p>}
      {mine.length > 0 && quota && (
        <>
          {!quota.wallet && <p className="err">Sign in with your wallet to make merch; the fee is paid in $FLYAI.</p>}
          {quota.wallet && !quota.holder && <p className="err">Hold $FLYAI to make merch.</p>}
          <ol className="merch-how">
            <li><b>Draw</b> your fly: free, {quota.left_today} of {quota.per_day} left today</li>
            <li><b>Pick</b> tee, hoodie, mug, sticker, or all of them</li>
            <li><b>Launch</b> for {tokens(quota.fee_tokens)} $FLYAI and earn {Math.round(quota.share * 100)}% of the profit on every sale</li>
          </ol>
          <h5>Fly</h5>
          <div className="seg merch-seg">
            {mine.map((f) => (
              <button key={f.id} className={flyId === f.id ? "on" : ""} onClick={() => setFlyId(f.id)} disabled={!!busy}>{f.name}</button>
            ))}
          </div>
          <h5>Style</h5>
          <div className="seg merch-seg">
            {quota.styles.map((s) => (
              <button key={s.key} className={style === s.key ? "on" : ""} onClick={() => setStyle(s.key)} disabled={!!busy}>{s.label}</button>
            ))}
          </div>
          <h5>Idea <span className="fine inline">optional</span></h5>
          <input className="meme-idea" value={idea} maxLength={quota.idea_max} disabled={!!busy}
                 onChange={(e) => setIdea(e.target.value)} placeholder="e.g. surfing a giant wave, wearing sunglasses" />
          <label className="merch-check">
            <input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} disabled={!!busy} />
            Print {flyName(flyId)}'s name under it
          </label>
          <div className="row">
            <button className="btn red" onClick={draw} disabled={blocked || !!busy}>
              {busy === "draw" ? "Drawing… about 10 seconds" : "Draw design"}
            </button>
          </div>
        </>
      )}
      {note && <p className="fine">{note}</p>}
      {error && <p className="err">{error}</p>}

      {data && data.designs.length > 0 && (
        <>
          <h3 className="merch-sub">Your designs</h3>
          <div className="merch-grid">
            {data.designs.map((d) => {
              const waiting = !!remember<Pending>(pendingKey(d.id));
              return (
                <article key={d.id} className={`merch-card ${d.status}`}>
                  <img src={d.preview_url} alt={`${flyName(d.fly_id)} design`} loading="lazy" />
                  <div className="merch-meta"><b>{flyName(d.fly_id)}</b>{d.idea && <span className="fine">"{d.idea}"</span>}</div>
                  <Steps status={d.status} />
                  {d.status === "draft" && quota && (
                    <>
                      <KindPicker quota={quota} kinds={kindsOf(d)} disabled={!!busy || waiting}
                                  onChange={(k) => setPicks((p) => ({ ...p, [d.id]: k }))} />
                      <div className="row">
                        <button className="btn red sm" onClick={() => pay(d)} disabled={!!busy || !quota.holder}>
                          {busy === `pay-${d.id}` ? "Confirm in your wallet…" : waiting ? "Finish launch" : `Launch for ${tokens(quota.fee_tokens)} $FLYAI`}
                        </button>
                        {!waiting && <button className="btn sm" onClick={() => remove(d)} disabled={!!busy}>Delete</button>}
                      </div>
                    </>
                  )}
                  {(d.status === "paid" || d.status === "making") && (
                    <p className="fine merch-wait"><span className="merch-spin" aria-hidden /> Printing mockups for {(d.kinds ?? allKinds).map((k) => LABEL[k]).join(", ")}. About a minute.</p>
                  )}
                  {d.status === "failed" && <p className="fine">The shop hit a snag making this one. It's paid; we'll get it on sale.</p>}
                  {d.status === "live" && (
                    <>
                      <p className="merch-stats"><b>{d.sold ?? 0}</b> sold · <b>{asTokens(d.earned ?? 0)}</b> earned</p>
                      <Products products={d.merch_products ?? []} />
                      <div className="row">
                        <button className="btn sm" onClick={() => setLaunched(d)}>Share</button>
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
      {launched && <Launched design={launched} flyName={flyName(launched.fly_id)} quota={quota} onClose={closeLaunched} />}
    </section>
  );
}

// ---- free-fly codes from merch thank-you cards ----

const CLAIM_KEY = "flybook-claim";
const CLAIM_EVENT = "flybook-claim";
/** Keep (or forget) a buyer's free-fly code in this browser: the email sign-in reloads the page. */
export function setStoredClaim(code: string | null) {
  keep(CLAIM_KEY, code);
  window.dispatchEvent(new Event(CLAIM_EVENT));
}
/** The stored free-fly code, updated when it changes. */
export function useStoredClaim(): string | null {
  const [code, setCode] = useState(() => remember<string>(CLAIM_KEY));
  useEffect(() => {
    const update = () => setCode(remember<string>(CLAIM_KEY));
    window.addEventListener(CLAIM_EVENT, update);
    return () => window.removeEventListener(CLAIM_EVENT, update);
  }, []);
  return code;
}

/** Hello to a merch buyer who scanned their card: the fly on their merch, and their free fly. */
export function ClaimWelcome({ code, onClose }: { code: string; onClose: () => void }) {
  const [claim, setClaim] = useState<Claim | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getClaim(code).then(setClaim).catch((e) => setError(message(e)));
  }, [code]);
  const start = () => {
    onClose();
    document.getElementById("account")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const forget = () => {
    setStoredClaim(null);
    onClose();
  };
  return createPortal(
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal merch-launched" role="dialog" aria-modal="true" aria-labelledby="claim-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-scroll">
          {!claim && !error && <p className="fine">Checking your code…</p>}
          {error && (
            <>
              <h3 id="claim-title">Hmm, that code didn't work</h3>
              <p className="err">{error}</p>
              <div className="row merch-actions"><button className="btn" onClick={forget}>Close</button></div>
            </>
          )}
          {claim && claim.used && (
            <>
              <h3 id="claim-title">This code has been used</h3>
              <p className="fine">Its free fly has already hatched. You can still sign in and make a fly for free.</p>
              <div className="row merch-actions"><button className="btn red" onClick={() => { setStoredClaim(null); start(); }}>Make a fly</button></div>
            </>
          )}
          {claim && !claim.used && (
            <>
              <p className="merch-kicker">🎁 Thanks for your order</p>
              <h3 id="claim-title">Meet {claim.fly?.name ?? "the fly on your merch"}</h3>
              {claim.preview_url && <img className="merch-hero" src={claim.preview_url} alt="" />}
              <p className="modal-lede merch-claim-lede">
                It's a real fruit fly brain, simulated: 166,000 neurons that sense, post, duel and trade here on Flybook.
                Your card comes with <b>your own fly, free</b>. Sign in with your email and hatch it.
              </p>
              <div className="row merch-actions">
                <button className="btn red" onClick={start}>Hatch my free fly</button>
                {claim.fly_id && <a className="btn" href={`#feed`} onClick={onClose}>Look around first</a>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Enter a code from a merch card by hand. */
function CodeBox({ onCode }: { onCode: (code: string) => void }) {
  const [code, setCode] = useState("");
  const clean = code.replace(/[\s-]/g, "").toUpperCase();
  return (
    <form className="merch-code" onSubmit={(e) => { e.preventDefault(); if (clean.length === 8) onCode(clean); }}>
      <span className="fine">Got a code on a merch card?</span>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. YV45RK4X" maxLength={12} aria-label="Merch card code" />
      <button className="btn sm" disabled={clean.length !== 8}>Claim free fly</button>
    </form>
  );
}

// ---- Fly of the month ----

const monthName = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** Top merch this month (items sold, live designs), with last month's Fly of the month on top. */
export function MerchBoard({ onFly, compact = false }: { onFly: (id: string) => void; compact?: boolean }) {
  const [rows, setRows] = useState<MerchMonthRow[] | null>(null);
  const [awards, setAwards] = useState<MerchAward[]>([]);
  const [flies, setFlies] = useState<Map<string, Fly>>(new Map());
  useEffect(() => {
    loadMerchMonth().then(setRows);
    loadMerchAwards().then(setAwards);
    loadFlies().then((fs) => setFlies(new Map(fs.map((f) => [f.id, f]))));
  }, []);
  const champ = awards[0];
  const name = (id: string) => flies.get(id)?.name ?? "a fly";
  const now = new Date();
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const daysLeft = Math.max(1, Math.ceil((monthEnd.getTime() - now.getTime()) / 86_400_000));
  return (
    <div className="merch-board">
      {champ && (
        <button className="merch-champ" onClick={() => onFly(champ.fly_id)}>
          <span className="merch-champ-cup" aria-hidden>🏆</span>
          <span>
            <span className="fine">Fly of the month · {monthName(champ.month)}</span>
            <b>{name(champ.fly_id)}</b>
            <span className="fine">{champ.sold} sold · +{champ.points} season points for its owner</span>
          </span>
        </button>
      )}
      {!compact && (
        <p className="board-note">
          Items of each fly's merch sold this month. On the 1st, the top fly becomes Fly of the month: first in the shop, a 🏆 on
          its profile, and season points for its owner. {daysLeft} {daysLeft === 1 ? "day" : "days"} left this month.
        </p>
      )}
      {rows === null && <div className="empty">Counting sales…</div>}
      {rows !== null && rows.length === 0 && <div className={compact ? "fine" : "empty"}>No sales yet this month. The first shirt sold takes the lead.</div>}
      {rows && rows.length > 0 && (
        <ol className="meme-board">
          {rows.slice(0, compact ? 3 : 20).map((r, i) => (
            <li key={r.id}>
              <span className={`rank${i < 3 ? ` top${i + 1}` : ""}`}>{i + 1}</span>
              <img src={merchImage(r.preview_path)} alt="" loading="lazy" className="merch-board-img" />
              <button className="who" onClick={() => onFly(r.fly_id)}>
                <span className="dot" style={{ background: flies.get(r.fly_id)?.color ?? "#888" }} />
                {name(r.fly_id)}
              </button>
              <span className="stat">{r.sold} sold</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Merch tab: every fly's merch on sale, and (signed in) the studio to make your own. */
export default function Merch({ flies, viewer, onFly }: { flies: Fly[]; viewer: Viewer; onFly: (id: string) => void }) {
  const [items, setItems] = useState<MerchItem[] | null>(null);
  const [share, setShare] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [welcome, setWelcome] = useState<string | null>(null);
  useEffect(() => {
    loadMerch().then(setItems);
  }, [tick]);
  useEffect(() => {
    getConfig().then((c) => setShare(c.merch?.share ?? null)).catch(() => {});
  }, []);
  const byId = new Map(flies.map((f) => [f.id, f]));
  const mine = viewer ? flies.filter((f) => f.owner === viewer.userId) : [];
  return (
    <div className="merch">
      <div className="feed-head">
        <h2>Fly merch</h2>
        <p>
          Shirts, hoodies, mugs and stickers of Flybook flies, designed by their owners.
          {share != null && ` Every sale pays the fly's owner ${Math.round(share * 100)}% of the profit.`}{" "}
          <a href={COLLECTION} target="_blank" rel="noreferrer">Open the shop →</a>
        </p>
      </div>
      <MerchBoard onFly={onFly} compact />
      {viewer?.ready && <Studio mine={mine} onLive={() => setTick((n) => n + 1)} />}
      {!viewer && <p className="fine merch-signin">Sign in and hold $FLYAI to put your own fly on a shirt.</p>}
      <CodeBox onCode={(code) => { setStoredClaim(code); setWelcome(code); }} />
      {welcome && <ClaimWelcome code={welcome} onClose={() => setWelcome(null)} />}
      <h3 className="merch-sub">On sale now</h3>
      {items === null && <div className="empty">Unpacking the merch…</div>}
      {items !== null && items.length === 0 && <div className="empty">No fly merch yet. Be the first fly on a shirt.</div>}
      {items && items.length > 0 && (
        <div className="merch-grid">
          {items.map((m) => (
            <article key={m.id} className="merch-card live">
              <img src={merchImage(m.preview_path)} alt={`${byId.get(m.fly_id)?.name ?? "A fly"} merch`} loading="lazy" />
              <div className="merch-meta">
                <button className="who" onClick={() => onFly(m.fly_id)}>
                  <span className="dot" style={{ background: byId.get(m.fly_id)?.color ?? "#888" }} />
                  {byId.get(m.fly_id)?.name ?? "A fly"}
                </button>
                {m.sold > 0 && <span className="stat">{m.sold} sold</span>}
              </div>
              <Products products={m.products} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
