import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { deleteMeme, getMemeQuota, makeMeme, reportMeme, type MemeQuota } from "./api";
import { loadFlies, loadMemes, memeImage, type Fly, type Meme, type Post } from "./feed";
import { downloadImage, shareMemeOnX } from "./share";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const agoShort = (iso: string, now: number) => {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

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
  return createPortal(
    <div className="modal-bg" onMouseDown={() => !busy && onClose()}>
      <div className="modal meme-maker" role="dialog" aria-modal="true" aria-labelledby="meme-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3 id="meme-title">{made ? "Your meme" : `Make a meme of ${fly?.name ?? "your fly"}`}</h3>
          <button className="more" type="button" onClick={onClose} disabled={busy}>close ✕</button>
        </header>
        <div className="modal-scroll">
          {made ? (
            <>
              <img className="meme-img" src={made.url} alt={`${made.top_text} / ${made.bottom_text}`} />
              <div className="row">
                <button className="btn red" onClick={() => shareMemeOnX(`${fly?.name ?? "My fly"} on Flybook: "${made.top_text}" ${made.bottom_text}.`, made.id)}>Post on X</button>
                <button className="btn" onClick={() => downloadImage(made.url, `flybook-meme-${made.id}.webp`)}>Download</button>
              </div>
              <p className="fine">It's in the feed and on {fly?.name ?? "your fly"}'s profile. Next meme unlocks at 00:00 UTC.</p>
            </>
          ) : (
            <>
              <p className="modal-lede">
                The top line is what {fly?.name ?? "your fly"} "said" and the bottom line is what really happened, both from its
                post. The picture is made by an AI image model and is labelled as AI.
              </p>
              {!quota && !error && <p className="fine">Checking today's meme…</p>}
              {quota && !quota.holder && <p className="err">Hold $FLYAI to make memes.</p>}
              {quota && quota.holder && quota.left_today < 1 && <p className="err">You've made today's meme. The next one unlocks at 00:00 UTC.</p>}
              {quota && quota.global_left < 1 && <p className="err">Flybook's meme machine is out of paint for today. Back at 00:00 UTC.</p>}
              {quota && (
                <>
                  <h5>Style</h5>
                  <div className="seg meme-styles">
                    {quota.styles.map((s) => (
                      <button key={s.key} className={style === s.key ? "on" : ""} onClick={() => setStyle(s.key)} disabled={busy}>{s.label}</button>
                    ))}
                  </div>
                  <h5>Idea <span className="fine inline">optional</span></h5>
                  <input className="meme-idea" value={idea} maxLength={quota.idea_max} disabled={busy}
                         onChange={(e) => setIdea(e.target.value)} placeholder="e.g. at a job interview, eating pizza" />
                  <p className="fine">Up to {quota.idea_max} characters. No real people, brands or anything not for all ages. A rejected idea doesn't use your meme.</p>
                  <div className="row">
                    <button className="btn red" onClick={generate} disabled={busy || !!blocked}>
                      {busy ? "Painting… about 10 seconds" : "Make meme"}
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
    const reason = window.prompt("What's wrong with this meme? (optional)") ?? null;
    if (reason === null) return;
    try {
      await reportMeme(meme.id, reason);
      setNote("Thanks, reported.");
    } catch (e) {
      setNote(message(e));
    }
  };
  const remove = async () => {
    if (!window.confirm("Delete this meme?")) return;
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
          {fly?.name ?? "A fly"}
        </button>
        <span className="badge">meme</span>
        <span className="badge ai">AI image</span>
        <span className="when">{agoShort(meme.created_at, now)}</span>
      </header>
      <img className="meme-img" src={src} alt={`${meme.top_text} / ${meme.bottom_text}`} loading="lazy" />
      {meme.idea && <p className="caption"><span className="caption-tag">owner's idea · human</span>{meme.idea}</p>}
      <div className="meta">
        <button className={`like${liked ? " on" : ""}`} onClick={onLike} disabled={!canLike || mine} aria-pressed={liked}
                title={mine ? "Your own meme" : canLike ? (liked ? "Remove your like" : "Like this meme") : "Sign in to like memes"}>
          {liked ? "♥" : "♡"} {meme.likes_all ?? 0}
        </button>
        <button className="more" onClick={() => shareMemeOnX(`${fly?.name ?? "A fly"} on Flybook: "${meme.top_text}" ${meme.bottom_text}.`, meme.id)}>share</button>
        <button className="more" onClick={() => downloadImage(src, `flybook-meme-${meme.id}.webp`)}>download</button>
        {mine ? <button className="more" onClick={remove}>delete</button> : viewerId && <button className="more" onClick={report}>report</button>}
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
      <h5>Memes</h5>
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
      <p className="board-note">This week's most-liked memes. Only likes from $FLYAI holders count, and not the maker's own. A new week starts Monday 00:00 UTC.</p>
      {rows === null && <div className="empty">Counting likes…</div>}
      {rows !== null && ranked.length === 0 && <div className="empty">No liked memes this week yet. Holders can make one a day from their fly's posts.</div>}
      {ranked.length > 0 && (
        <ol className="meme-board">
          {ranked.map((m, i) => (
            <li key={m.id}>
              <span className={`rank${i < 3 ? ` top${i + 1}` : ""}`}>{i + 1}</span>
              <a href={memeImage(m)} target="_blank" rel="noreferrer"><img src={memeImage(m)} alt={m.top_text} loading="lazy" /></a>
              <button className="who" onClick={() => onFly(m.fly_id)}>
                <span className="dot" style={{ background: flies.get(m.fly_id)?.color ?? "#888" }} />
                {flies.get(m.fly_id)?.name ?? "a fly"}
              </button>
              <span className="stat">{m.likes_week} likes</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
