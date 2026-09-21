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
import { Html, locale, t, tAt, tOr, tn } from "./i18n";

const SHOP = "https://shop.flyaiworld.com";
const COLLECTION = `${SHOP}/collections/fly-merch`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];
const usd = (x: number) => `$${x.toFixed(2)}`;
const tokens = (x: number) => Math.round(x).toLocaleString(locale());
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const LABEL = (kind: string) => tOr(`flybook.merch.kinds.${kind}`, kind);
const ICON: Record<string, string> = { tee: "👕", hoodie: "🧥", mug: "☕", sticker: "🏷️" };
const ORDER = ["tee", "hoodie", "mug", "sticker"];
const byKind = <T extends { kind: string }>(xs: T[]) => [...xs].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
const dayName = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale(), { day: "numeric", month: "long" });

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
  intent.searchParams.set("text", t("flybook.merch.shareText", { name: flyName }));
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
          <span>{LABEL(p.kind)}</span>
          {p.price != null && <span className="mono">{usd(Number(p.price))}</span>}
        </a>
      ))}
    </div>
  );
}

const STEPS = ["drawn", "paid", "printing", "onSale"] as const;
function Steps({ status }: { status: MerchDesign["status"] }) {
  const at = status === "draft" ? 0 : status === "paid" ? 1 : status === "making" || status === "failed" ? 2 : 3;
  return (
    <ol className="merch-steps" aria-label={t("flybook.merch.stepOf", { n: at + 1, step: tAt("flybook.merch.steps", STEPS[at]) })}>
      {STEPS.map((s, i) => (
        <li key={s} className={i < at || status === "live" ? "done" : i === at ? (status === "failed" ? "stuck" : "now") : ""}>{tAt("flybook.merch.steps", s)}</li>
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
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { window.prompt(t("flybook.merch.copyPrompt"), link); }
  };
  return createPortal(
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal merch-launched" role="dialog" aria-modal="true" aria-labelledby="launched-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-scroll">
          <p className="merch-kicker">{t("flybook.merch.live")}</p>
          <h3 id="launched-title">{t("flybook.merch.onSaleTitle", { name: flyName })}</h3>
          <img className="merch-hero" src={design.preview_url} alt={t("flybook.merch.designAlt", { name: flyName })} />
          <Products products={products} big />
          <div className="merch-earn-list">
            {products.filter((p) => earn.has(p.kind)).map((p) => (
              <span key={p.kind}>{tn("flybook.merch.youEarn", { kind: LABEL(p.kind), usd: <b>{usd(earn.get(p.kind)!)}</b> })}</span>
            ))}
          </div>
          <p className="fine">{t("flybook.merch.earningsNote")}</p>
          <div className="row merch-actions">
            <button className="btn red" onClick={() => shareMerch(flyName, link)}>{t("flybook.merch.postOnX")}</button>
            <button className="btn" onClick={copy}>{t(copied ? "flybook.merch.linkCopied" : "flybook.merch.copyLink")}</button>
            <a className="btn" href={link} target="_blank" rel="noreferrer">{t("flybook.merch.openInShop")}</a>
            <button className="btn" onClick={onClose}>{t("flybook.merch.done")}</button>
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
    <div className="merch-kinds" role="group" aria-label={t("flybook.merch.productsLabel")}>
      {quota.products.map((p) => {
        const on = kinds.includes(p.kind);
        return (
          <button key={p.kind} type="button" className={`merch-kind${on ? " on" : ""}`} aria-pressed={on} disabled={disabled}
                  onClick={() => toggle(p.kind)} title={on && kinds.length === 1 ? t("flybook.merch.keepOne") : undefined}>
            <span className="merch-kind-top"><span>{ICON[p.kind]} {tOr(`flybook.merch.kinds.${p.kind}`, p.label)}</span><span className="merch-tick">{on ? "✓" : ""}</span></span>
            <span className="fine">{t("flybook.merch.fromEarn", { from: usd(p.from), earn: usd(p.earn_each) })}</span>
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
      if (showName && d.name_printed === false) setNote(t("flybook.merch.nameLeftOff"));
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
        if (!address) throw new Error(t("flybook.merch.connectFirst"));
        if (quota.wallet && address.toLowerCase() !== quota.wallet) {
          throw new Error(t("flybook.merch.payFrom", { wallet: short(quota.wallet) }));
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
      setError(/rejected|denied/i.test(m) ? t("flybook.merch.cancelled") : m);
      if (/already paid|before this design|sends no \$FLYAI|failed on chain/.test(m)) keep(pendingKey(d.id), null);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (d: MerchDesign) => {
    if (!window.confirm(t("flybook.merch.deleteConfirm"))) return;
    try {
      await deleteDesign(d.id);
      refresh();
    } catch (e) {
      setError(message(e));
    }
  };

  const flyName = (id: string) => mine.find((f) => f.id === id)?.name ?? t("flybook.merch.yourFly");
  const blocked = !quota || !quota.holder || quota.left_today < 1 || quota.global_left < 1 || !flyId;
  const asTokens = (x: number) => (data?.flyai_usd ? `${tokens(x / data.flyai_usd)} $FLYAI` : usd(x));
  return (
    <section className="merch-studio">
      {data && data.designs.some((d) => d.status === "live") && (
        <div className="merch-payout">
          <div>
            <span className="fine">{t("flybook.merch.comingOn", { date: dayName(data.payout_date) })}</span>
            <span className="merch-payout-big mono">
              {data.unpaid_tokens != null ? `${tokens(data.unpaid_tokens)} $FLYAI` : usd(data.unpaid)}
            </span>
            <span className="fine">
              {data.unpaid_tokens != null && t("flybook.merch.atToday", { usd: usd(data.unpaid) })}
              {t("flybook.merch.shareOfProfit", { pct: Math.round(data.share * 100) })}
            </span>
          </div>
          <div className="merch-payout-side">
            <span>{tn("flybook.merch.earned", { usd: <b className="mono">{usd(data.earned)}</b> })}</span>
            <span>{tn("flybook.merch.paidOut", { usd: <b className="mono">{usd(data.paid)}</b> })}</span>
          </div>
        </div>
      )}

      <h3>{t("flybook.merch.makeTitle")}</h3>
      {!mine.length && <p className="fine">{t("flybook.merch.hatchFirst")}</p>}
      {mine.length > 0 && quota && (
        <>
          {!quota.wallet && <p className="err">{t("flybook.merch.walletNeeded")}</p>}
          {quota.wallet && !quota.holder && <p className="err">{t("flybook.merch.holdToMake")}</p>}
          <ol className="merch-how">
            <Html as="li" k="flybook.merch.howDraw" vars={{ left: quota.left_today, perDay: quota.per_day }} />
            <Html as="li" k="flybook.merch.howPick" />
            <Html as="li" k="flybook.merch.howLaunch" vars={{ fee: tokens(quota.fee_tokens), pct: Math.round(quota.share * 100) }} />
          </ol>
          <h5>{t("flybook.merch.fly")}</h5>
          <div className="seg merch-seg">
            {mine.map((f) => (
              <button key={f.id} className={flyId === f.id ? "on" : ""} onClick={() => setFlyId(f.id)} disabled={!!busy}>{f.name}</button>
            ))}
          </div>
          <h5>{t("flybook.merch.style")}</h5>
          <div className="seg merch-seg">
            {quota.styles.map((s) => (
              <button key={s.key} className={style === s.key ? "on" : ""} onClick={() => setStyle(s.key)} disabled={!!busy}>
                {tOr(`flybook.merch.styles.${s.key}`, s.label)}
              </button>
            ))}
          </div>
          <h5>{t("flybook.merch.idea")} <span className="fine inline">{t("flybook.merch.optional")}</span></h5>
          <input className="meme-idea" value={idea} maxLength={quota.idea_max} disabled={!!busy}
                 onChange={(e) => setIdea(e.target.value)} placeholder={t("flybook.merch.ideaPlaceholder")} />
          <label className="merch-check">
            <input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} disabled={!!busy} />
            {t("flybook.merch.printName", { name: flyName(flyId) })}
          </label>
          <div className="row">
            <button className="btn red" onClick={draw} disabled={blocked || !!busy}>
              {t(busy === "draw" ? "flybook.merch.drawing" : "flybook.merch.draw")}
            </button>
          </div>
        </>
      )}
      {note && <p className="fine">{note}</p>}
      {error && <p className="err">{error}</p>}

      {data && data.designs.length > 0 && (
        <>
          <h3 className="merch-sub">{t("flybook.merch.yourDesigns")}</h3>
          <div className="merch-grid">
            {data.designs.map((d) => {
              const waiting = !!remember<Pending>(pendingKey(d.id));
              return (
                <article key={d.id} className={`merch-card ${d.status}`}>
                  <img src={d.preview_url} alt={t("flybook.merch.designAlt", { name: flyName(d.fly_id) })} loading="lazy" />
                  <div className="merch-meta"><b>{flyName(d.fly_id)}</b>{d.idea && <span className="fine">"{d.idea}"</span>}</div>
                  <Steps status={d.status} />
                  {d.status === "draft" && quota && (
                    <>
                      <KindPicker quota={quota} kinds={kindsOf(d)} disabled={!!busy || waiting}
                                  onChange={(k) => setPicks((p) => ({ ...p, [d.id]: k }))} />
                      <div className="row">
                        <button className="btn red sm" onClick={() => pay(d)} disabled={!!busy || !quota.holder}>
                          {busy === `pay-${d.id}` ? t("flybook.merch.confirmWallet") : waiting ? t("flybook.merch.finishLaunch") : t("flybook.merch.launchFor", { fee: tokens(quota.fee_tokens) })}
                        </button>
                        {!waiting && <button className="btn sm" onClick={() => remove(d)} disabled={!!busy}>{t("flybook.merch.delete")}</button>}
                      </div>
                    </>
                  )}
                  {(d.status === "paid" || d.status === "making") && (
                    <p className="fine merch-wait"><span className="merch-spin" aria-hidden /> {t("flybook.merch.printingFor", { kinds: (d.kinds ?? allKinds).map(LABEL).join(", ") })}</p>
                  )}
                  {d.status === "failed" && <p className="fine">{t("flybook.merch.snag")}</p>}
                  {d.status === "live" && (
                    <>
                      <p className="merch-stats">{tn("flybook.merch.soldEarned", { sold: <b>{d.sold ?? 0}</b>, earned: <b>{asTokens(d.earned ?? 0)}</b> })}</p>
                      <Products products={d.merch_products ?? []} />
                      <div className="row">
                        <button className="btn sm" onClick={() => setLaunched(d)}>{t("flybook.merch.share")}</button>
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
          {!claim && !error && <p className="fine">{t("flybook.merch.checkingCode")}</p>}
          {error && (
            <>
              <h3 id="claim-title">{t("flybook.merch.codeFailed")}</h3>
              <p className="err">{error}</p>
              <div className="row merch-actions"><button className="btn" onClick={forget}>{t("flybook.merch.close")}</button></div>
            </>
          )}
          {claim && claim.used && (
            <>
              <h3 id="claim-title">{t("flybook.merch.codeUsed")}</h3>
              <p className="fine">{t("flybook.merch.codeUsedNote")}</p>
              <div className="row merch-actions"><button className="btn red" onClick={() => { setStoredClaim(null); start(); }}>{t("flybook.merch.makeFly")}</button></div>
            </>
          )}
          {claim && !claim.used && (
            <>
              <p className="merch-kicker">{t("flybook.merch.thanks")}</p>
              <h3 id="claim-title">{t("flybook.merch.meet", { name: claim.fly?.name ?? t("flybook.merch.theFly") })}</h3>
              {claim.preview_url && <img className="merch-hero" src={claim.preview_url} alt="" />}
              <Html as="p" className="modal-lede merch-claim-lede" k="flybook.merch.claimLede" />
              <div className="row merch-actions">
                <button className="btn red" onClick={start}>{t("flybook.merch.hatchMine")}</button>
                {claim.fly_id && <a className="btn" href={`#feed`} onClick={onClose}>{t("flybook.merch.lookAround")}</a>}
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
      <span className="fine">{t("flybook.merch.gotCode")}</span>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("flybook.merch.codePlaceholder")} maxLength={12} aria-label={t("flybook.merch.codeLabel")} />
      <button className="btn sm" disabled={clean.length !== 8}>{t("flybook.merch.claim")}</button>
    </form>
  );
}

// ---- Fly of the month ----

const monthName = (iso: string) => new Date(iso).toLocaleDateString(locale(), { month: "long", year: "numeric", timeZone: "UTC" });

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
  const name = (id: string) => flies.get(id)?.name ?? t("flybook.merch.aFly");
  const now = new Date();
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const daysLeft = Math.max(1, Math.ceil((monthEnd.getTime() - now.getTime()) / 86_400_000));
  return (
    <div className="merch-board">
      {champ && (
        <button className="merch-champ" onClick={() => onFly(champ.fly_id)}>
          <span className="merch-champ-cup" aria-hidden>🏆</span>
          <span>
            <span className="fine">{t("flybook.merch.flyOfMonth", { month: monthName(champ.month) })}</span>
            <b>{name(champ.fly_id)}</b>
            <span className="fine">{t("flybook.merch.champLine", { sold: champ.sold, points: champ.points })}</span>
          </span>
        </button>
      )}
      {!compact && (
        <p className="board-note">{t("flybook.merch.boardNote", { count: daysLeft })}</p>
      )}
      {rows === null && <div className="empty">{t("flybook.merch.countingSales")}</div>}
      {rows !== null && rows.length === 0 && <div className={compact ? "fine" : "empty"}>{t("flybook.merch.noSales")}</div>}
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
              <span className="stat">{t("flybook.merch.sold", { n: r.sold })}</span>
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
        <h2>{t("flybook.merch.title")}</h2>
        <p>
          {t("flybook.merch.intro")}
          {share != null && t("flybook.merch.ownerShare", { pct: Math.round(share * 100) })}{" "}
          <a href={COLLECTION} target="_blank" rel="noreferrer">{t("flybook.merch.openShop")}</a>
        </p>
      </div>
      <MerchBoard onFly={onFly} compact />
      {viewer?.ready && <Studio mine={mine} onLive={() => setTick((n) => n + 1)} />}
      {!viewer && <p className="fine merch-signin">{t("flybook.merch.signInHold")}</p>}
      <CodeBox onCode={(code) => { setStoredClaim(code); setWelcome(code); }} />
      {welcome && <ClaimWelcome code={welcome} onClose={() => setWelcome(null)} />}
      <h3 className="merch-sub">{t("flybook.merch.onSaleNow")}</h3>
      {items === null && <div className="empty">{t("flybook.merch.unpacking")}</div>}
      {items !== null && items.length === 0 && <div className="empty">{t("flybook.merch.noMerch")}</div>}
      {items && items.length > 0 && (
        <div className="merch-grid">
          {items.map((m) => (
            <article key={m.id} className="merch-card live">
              <img src={merchImage(m.preview_path)} alt={t("flybook.merch.merchAlt", { name: byId.get(m.fly_id)?.name ?? t("flybook.merch.aFlyCap") })} loading="lazy" />
              <div className="merch-meta">
                <button className="who" onClick={() => onFly(m.fly_id)}>
                  <span className="dot" style={{ background: byId.get(m.fly_id)?.color ?? "#888" }} />
                  {byId.get(m.fly_id)?.name ?? t("flybook.merch.aFlyCap")}
                </button>
                {m.sold > 0 && <span className="stat">{t("flybook.merch.sold", { n: m.sold })}</span>}
              </div>
              <Products products={m.products} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
