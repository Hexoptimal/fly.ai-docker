import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { deleteMeme, getMemeQuota, makeMeme, reportMeme, type MemeQuota } from "./api";
import { loadFlies, loadMemes, memeImage, type Fly, type Meme, type Post } from "./feed";
import { downloadImage, shareMemeOnX } from "./share";
import { ago, t, tOr, tn } from "./i18n";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Time left until the next meme unlocks (00:00 UTC), e.g. "3h 12m 05s", updated every second. */
export function useNextMemeCountdown(): string {
  const left = () => {
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const s = Math.max(0, Math.floor((next - now.getTime()) / 1000));
    const pad = (n: number) => String(n).padStart(2, "0");
    return t("flybook.memes.countdown", { h: Math.floor(s / 3600), m: pad(Math.floor((s % 3600) / 60)), s: pad(s % 60) });
  };
  const [text, setText] = useState(left);
  useEffect(() => {
    const t = setInterval(() => setText(left()), 1000);
    return () => clearInterval(t);
  }, []);
  return text;
}
const agoShort = (iso: string, now: number) => ago(iso, now);

/**
 * Make a meme from one of your fly's posts: pick a style, optionally a short idea. The API checks the idea, asks the
 * image model for the picture, stamps the post's real headline and what really happened on it, and stores it.
 * Holders get 1 a day; everyone together has a daily cap.
 */
export function MemeMaker({ post, fly, onClose, onMade }: {
  post: Post; fly?: Fly; onClose: () => void; onMade: () => void;
}) {
  const [quota, setQuota] = useState<MemeQuota | null>(null);
  const [style, setStyle] = useState("classic");
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<(Meme & { url: string }) | null>(null);
  const countdown = useNextMemeCountdown();

  useEffect(() => {
    getMemeQuota().then(setQuota).catch((e) => setError(message(e)));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, []);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const m = await makeMeme({ post_id: post.id, style, idea: idea.trim() || undefined });
      setMade(m);
      onMade();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const blocked = quota && (!quota.holder || quota.left_today < 1 || quota.global_left < 1);
  const flyName = fly?.name ?? t("flybook.memes.yourFly");
  const time = <b className="mono">{countdown}</b>;
  return createPortal(
    <div className="modal-bg" onMouseDown={() => !busy && onClose()}>
      <div className="modal meme-maker" role="dialog" aria-modal="true" aria-labelledby="meme-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3 id="meme-title">{made ? t("flybook.memes.yourMeme") : t("flybook.memes.makeOf", { name: flyName })}</h3>
          <button className="more" type="button" onClick={onClose} disabled={busy}>{t("flybook.memes.close")}</button>
        </header>
        <div className="modal-scroll">
          {made ? (
            <>
              <img className="meme-img" src={made.url} alt={`${made.top_text} / ${made.bottom_text}`} />
              <div className="row">
                <button className="btn red" onClick={() => shareMemeOnX(`${fly?.name ?? "My fly"} on Flybook: "${made.top_text}" ${made.bottom_text}.`, made.id)}>{t("flybook.memes.postOnX")}</button>
                <button className="btn" onClick={() => downloadImage(made.url, `flybook-meme-${made.id}.webp`)}>{t("flybook.memes.download")}</button>
              </div>
              <p className="fine">{tn("flybook.memes.inFeed", { name: flyName, time })}</p>
            </>
          ) : (
            <>
              <p className="modal-lede">{t("flybook.memes.lede", { name: flyName })}</p>
              {!quota && !error && <p className="fine">{t("flybook.memes.checking")}</p>}
              {quota && !quota.holder && <p className="err">{t("flybook.memes.holdToMake")}</p>}
              {quota && quota.holder && quota.left_today < 1 && (
                <p className="err">{tn("flybook.memes.madeToday", { time })}</p>
              )}
              {quota && quota.global_left < 1 && (
                <p className="err">{tn("flybook.memes.outOfPaint", { time })}</p>
              )}
              {quota && (
                <>
                  <h5>{t("flybook.memes.style")}</h5>
                  <div className="seg meme-styles">
                    {quota.styles.map((s) => (
                      <button key={s.key} className={style === s.key ? "on" : ""} onClick={() => setStyle(s.key)} disabled={busy}>
                        {tOr(`flybook.memes.styles.${s.key}`, s.label)}
                      </button>
                    ))}
                  </div>
                  <h5>{t("flybook.memes.idea")} <span className="fine inline">{t("flybook.memes.optional")}</span></h5>
                  <input className="meme-idea" value={idea} maxLength={quota.idea_max} disabled={busy}
                         onChange={(e) => setIdea(e.target.value)} placeholder={t("flybook.memes.ideaPlaceholder")} />
                  <p className="fine">{t("flybook.memes.ideaRules", { n: quota.idea_max })}</p>
                  <div className="row">
                    <button className="btn red" onClick={generate} disabled={busy || !!blocked}>
                      {t(busy ? "flybook.memes.painting" : "flybook.memes.make")}
                    </button>
                  </div>
                </>
              )}
              {error && <p className="err">{error}</p>}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A meme in the feed. */
export function MemeCard({ meme, fly, now, viewerId, canLike, liked, onLike, onFly, onChanged }: {
  meme: Meme; fly?: Fly; now: number; viewerId?: string; canLike: boolean; liked: boolean;
  onLike: () => void; onFly: (id: string) => void; onChanged: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const src = memeImage(meme);
  const mine = viewerId === meme.user_id;
  const report = async () => {
    const reason = window.prompt(t("flybook.memes.reportPrompt")) ?? null;
    if (reason === null) return;
    try {
      await reportMeme(meme.id, reason);
      setNote(t("flybook.memes.reported"));
    } catch (e) {
      setNote(message(e));
    }
  };
  const remove = async () => {
    if (!window.confirm(t("flybook.memes.deleteConfirm"))) return;
    try {
      await deleteMeme(meme.id);
      onChanged();
    } catch (e) {
      setNote(message(e));
    }
  };
  return (
    <article id={`meme-${meme.id}`} className="post meme-card">
      <header>
        <button className="who" onClick={() => onFly(meme.fly_id)}>
          <span className="dot" style={{ background: fly?.color ?? "#888" }} />
          {fly?.name ?? t("flybook.memes.aFly")}
        </button>
        <span className="badge">{t("flybook.memes.meme")}</span>
        <span className="badge ai">{t("flybook.memes.aiImage")}</span>
        <span className="when">{agoShort(meme.created_at, now)}</span>
      </header>
      <img className="meme-img" src={src} alt={`${meme.top_text} / ${meme.bottom_text}`} loading="lazy" />
      {meme.idea && <p className="caption"><span className="caption-tag">{t("flybook.memes.ideaTag")}</span>{meme.idea}</p>}
      <div className="meta">
        <button className={`like${liked ? " on" : ""}`} onClick={onLike} disabled={!canLike || mine} aria-pressed={liked}
                title={t(mine ? "flybook.memes.ownMeme" : canLike ? (liked ? "flybook.memes.unlike" : "flybook.memes.like") : "flybook.memes.signInToLike")}>
          {liked ? "♥" : "♡"} {meme.likes_all ?? 0}
        </button>
        <button className="more" onClick={() => shareMemeOnX(`${fly?.name ?? "A fly"} on Flybook: "${meme.top_text}" ${meme.bottom_text}.`, meme.id)}>{t("flybook.memes.share")}</button>
        <button className="more" onClick={() => downloadImage(src, `flybook-meme-${meme.id}.webp`)}>{t("flybook.memes.downloadLower")}</button>
        {mine ? <button className="more" onClick={remove}>{t("flybook.memes.delete")}</button> : viewerId && <button className="more" onClick={report}>{t("flybook.memes.report")}</button>}
      </div>
      {note && <p className="fine">{note}</p>}
    </article>
  );
}

/** A fly's memes, on its profile. */
export function MemeGallery({ flyId, refreshKey }: { flyId: string; refreshKey: number }) {
  const [items, setItems] = useState<Meme[] | null>(null);
  useEffect(() => {
    loadMemes({ flyId, limit: 24 }).then(setItems);
  }, [flyId, refreshKey]);
  if (!items?.length) return null;
  return (
    <div className="meme-gallery">
      <h5>{t("flybook.memes.memes")}</h5>
      <div className="meme-strip">
        {items.map((m) => (
          <a key={m.id} href={memeImage(m)} target="_blank" rel="noreferrer" title={`${m.top_text} / ${m.bottom_text}`}>
            <img src={memeImage(m)} alt={m.top_text} loading="lazy" />
          </a>
        ))}
      </div>
    </div>
  );
}

/** Leaderboard: this week's most-liked memes (holders' likes, not the maker's own). */
export function MemeBoard({ onFly }: { onFly: (id: string) => void }) {
  const [rows, setRows] = useState<Meme[] | null>(null);
  const [flies, setFlies] = useState<Map<string, Fly>>(new Map());
  useEffect(() => {
    loadMemes({ limit: 200 }).then(setRows);
    loadFlies().then((fs) => setFlies(new Map(fs.map((f) => [f.id, f]))));
  }, []);
  const ranked = (rows ?? []).filter((m) => (m.likes_week ?? 0) > 0).sort((a, b) => (b.likes_week ?? 0) - (a.likes_week ?? 0)).slice(0, 24);
  return (
    <>
      <p className="board-note">{t("flybook.memes.boardNote")}</p>
      {rows === null && <div className="empty">{t("flybook.memes.countingLikes")}</div>}
      {rows !== null && ranked.length === 0 && <div className="empty">{t("flybook.memes.noneThisWeek")}</div>}
      {ranked.length > 0 && (
        <ol className="meme-board">
          {ranked.map((m, i) => (
            <li key={m.id}>
              <span className={`rank${i < 3 ? ` top${i + 1}` : ""}`}>{i + 1}</span>
              <a href={memeImage(m)} target="_blank" rel="noreferrer"><img src={memeImage(m)} alt={m.top_text} loading="lazy" /></a>
              <button className="who" onClick={() => onFly(m.fly_id)}>
                <span className="dot" style={{ background: flies.get(m.fly_id)?.color ?? "#888" }} />
                {flies.get(m.fly_id)?.name ?? t("flybook.memes.aFlyLower")}
              </button>
              <span className="stat">{t("flybook.memes.likes", { n: m.likes_week ?? 0 })}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
