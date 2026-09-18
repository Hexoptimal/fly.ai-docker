import { useEffect, useState } from "react";
import { useConnection } from "wagmi";
import { switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import type { Viewer } from "./Account";
import {
  deleteDesign, drawDesign, getConfig, getMerchQuota, getMyMerch, payDesign,
  type MerchDesign, type MerchQuota, type MyMerch,
} from "./api";
import { loadMerch, merchImage, type Fly, type MerchItem } from "./feed";
import { FLYAI, erc20, robinhood, wagmiConfig } from "./wallet";

const SHOP = "https://shop.flyaiworld.com";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];
const usd = (x: number) => `$${x.toFixed(2)}`;
const tokens = (x: number) => x.toLocaleString("en-US");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const LABEL: Record<string, string> = { tee: "Tee", hoodie: "Hoodie", mug: "Mug", sticker: "Sticker" };
const ORDER = ["tee", "hoodie", "mug", "sticker"];
const byKind = <T extends { kind: string }>(xs: T[]) => [...xs].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

// a payment sent but not yet accepted by the API survives a reload, so nobody pays twice
const pendingKey = (id: number) => `flybook-merch-pay-${id}`;
const pendingTx = (id: number): string | null => {
  try { return localStorage.getItem(pendingKey(id)); } catch { return null; }
};
const setPendingTx = (id: number, hash: string | null) => {
  try { hash ? localStorage.setItem(pendingKey(id), hash) : localStorage.removeItem(pendingKey(id)); } catch { /* private mode */ }
};

/** Submit a sent payment to the API, retrying while the chain confirms it. */
async function submitPayment(id: number, hash: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await payDesign(id, hash);
      setPendingTx(id, null);
      return;
    } catch (e) {
      if (!/isn't confirmed yet/.test(message(e)) || i >= 20) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function Products({ products }: { products: { kind: string; url: string | null; price: number | null }[] }) {
  return (
    <div className="merch-buy">
      {byKind(products).map((p) => (
        <a key={p.kind} className="btn sm" href={p.url ?? SHOP} target="_blank" rel="noreferrer">
          {LABEL[p.kind] ?? p.kind}{p.price != null && <span className="mono"> {usd(Number(p.price))}</span>}
        </a>
      ))}
    </div>
  );
}

/** The studio: draw a design of one of your flies, pay the fee, and track sales and earnings. */
function Studio({ mine, onLive }: { mine: Fly[]; onLive: () => void }) {
  const { address, chainId } = useConnection();
  const [quota, setQuota] = useState<MerchQuota | null>(null);
  const [data, setData] = useState<MyMerch | null>(null);
  const [flyId, setFlyId] = useState(mine[0]?.id ?? "");
  const [style, setStyle] = useState("sticker");
  const [idea, setIdea] = useState("");
  const [showName, setShowName] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = () => {
    getMerchQuota().then(setQuota).catch((e) => setError(message(e)));
    getMyMerch().then((d) => {
      setData((old) => {
        if (old && d.designs.some((x) => x.status === "live" && old.designs.find((o) => o.id === x.id)?.status !== "live")) onLive();
        return d;
      });
    }).catch((e) => setError(message(e)));
  };
  useEffect(refresh, []);
  useEffect(() => {   // flies load after the tab opens
    if (!mine.some((f) => f.id === flyId) && mine[0]) setFlyId(mine[0].id);
  }, [mine.map((f) => f.id).join(",")]);
  // products take a few minutes to make: check again while any design is being made
  const making = data?.designs.some((d) => d.status === "paid" || d.status === "making");
  useEffect(() => {
    if (!making) return;
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [making]);

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
      let hash = pendingTx(d.id);
      if (!hash) {
        if (!address) throw new Error("Connect your wallet first.");
        if (quota.wallet && address.toLowerCase() !== quota.wallet) {
          throw new Error(`Pay from the wallet you signed in with (${short(quota.wallet)}).`);
        }
        if (chainId !== robinhood.id) await switchChain(wagmiConfig, { chainId: robinhood.id });
        hash = await writeContract(wagmiConfig, {
          address: FLYAI, abi: erc20, functionName: "transfer", chainId: robinhood.id,
          args: [quota.treasury, BigInt(quota.fee_wei)],
        });
        setPendingTx(d.id, hash);
        await waitForTransactionReceipt(wagmiConfig, { hash: hash as `0x${string}`, chainId: robinhood.id });
      }
      await submitPayment(d.id, hash);
      refresh();
    } catch (e) {
      const m = message(e);
      setError(/rejected|denied/i.test(m) ? "Payment cancelled." : m);
      if (/already paid|before this design|sends no \$FLYAI|failed on chain/.test(m)) setPendingTx(d.id, null);
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
  return (
    <section className="merch-studio">
      <h3>Make merch of your fly</h3>
      {!mine.length && <p className="fine">Hatch a fly first, then come back and put it on a shirt.</p>}
      {mine.length > 0 && quota && (
        <>
          {!quota.wallet && <p className="err">Sign in with your wallet to make merch; the fee is paid in $FLYAI.</p>}
          {quota.wallet && !quota.holder && <p className="err">Hold $FLYAI to make merch.</p>}
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
          <p className="fine">
            Drawing is free: {quota.left_today} of {quota.per_day} left today. Like one? Pay {tokens(quota.fee_tokens)} $FLYAI
            and it goes on sale as a tee, hoodie, mug and sticker. You earn {Math.round(quota.share * 100)}% of the profit on
            every item sold.
          </p>
        </>
      )}
      {note && <p className="fine">{note}</p>}
      {error && <p className="err">{error}</p>}

      {data && data.designs.length > 0 && (
        <>
          <div className="merch-earnings">
            <div><span className="stat-big mono">{usd(data.earned)}</span><span className="fine">earned</span></div>
            <div><span className="stat-big mono">{usd(data.paid)}</span><span className="fine">paid out</span></div>
            <div><span className="stat-big mono">{usd(data.unpaid)}</span><span className="fine">coming to you</span></div>
          </div>
          <p className="fine">Earnings are paid to your wallet in $FLYAI once a month, after orders ship.</p>
          <div className="merch-grid">
            {data.designs.map((d) => {
              const waiting = pendingTx(d.id);
              return (
                <article key={d.id} className="merch-card">
                  <img src={d.preview_url} alt={`${flyName(d.fly_id)} design`} loading="lazy" />
                  <div className="merch-meta">
                    <b>{flyName(d.fly_id)}</b>
                    <span className={`merch-status ${d.status}`}>{
                      d.status === "draft" ? "draft" : d.status === "live" ? "on sale" : d.status === "failed" ? "stuck" : "making…"
                    }</span>
                  </div>
                  {d.idea && <p className="fine">"{d.idea}"</p>}
                  {d.status === "draft" && quota && (
                    <div className="row">
                      <button className="btn red sm" onClick={() => pay(d)} disabled={!!busy || !quota.holder}>
                        {busy === `pay-${d.id}` ? "Waiting for the wallet…" : waiting ? "Finish payment" : `Pay ${tokens(quota.fee_tokens)} $FLYAI`}
                      </button>
                      {!waiting && <button className="btn sm" onClick={() => remove(d)} disabled={!!busy}>Delete</button>}
                    </div>
                  )}
                  {(d.status === "paid" || d.status === "making") && <p className="fine">Paid. The shop is printing mockups; this takes a few minutes.</p>}
                  {d.status === "failed" && <p className="fine">Something went wrong making the products. We've been told and will put it on sale.</p>}
                  {d.status === "live" && (
                    <>
                      <p className="fine">{d.sold ?? 0} sold · you earned {usd(d.earned ?? 0)}</p>
                      <Products products={d.merch_products ?? []} />
                    </>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** Merch tab: every fly's merch on sale, and (signed in) the studio to make your own. */
export default function Merch({ flies, viewer, onFly }: { flies: Fly[]; viewer: Viewer; onFly: (id: string) => void }) {
  const [items, setItems] = useState<MerchItem[] | null>(null);
  const [share, setShare] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
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
          <a href={SHOP} target="_blank" rel="noreferrer">Open the shop →</a>
        </p>
      </div>
      {viewer?.ready && <Studio mine={mine} onLive={() => setTick((n) => n + 1)} />}
      {!viewer && <p className="fine merch-signin">Sign in and hold $FLYAI to put your own fly on a shirt.</p>}
      {items === null && <div className="empty">Unpacking the merch…</div>}
      {items !== null && items.length === 0 && <div className="empty">No fly merch yet. Be the first fly on a shirt.</div>}
      {items && items.length > 0 && (
        <div className="merch-grid">
          {items.map((m) => (
            <article key={m.id} className="merch-card">
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
