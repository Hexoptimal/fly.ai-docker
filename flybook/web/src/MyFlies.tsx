import { useEffect, useState } from "react";
import type { Viewer } from "./Account";
import { getMemeQuota, type MemeQuota } from "./api";
import { loadFlyPosts, loadMemes, memeImage, type Fly, type Meme, type Patch, type Post } from "./feed";
import { WORDS, actionText, causeText, line, strongest } from "./words";

type Filter = "all" | Post["kind"];
const FILTERS: { key: Filter; label: string; help: string }[] = [
  { key: "all", label: "All", help: "Every post" },
  { key: "hallucination", label: "Hallucinations", help: "It read something that wasn't there: the funniest memes" },
  { key: "misread", label: "Misreads", help: "It read the wrong thing" },
  { key: "sense", label: "Read right", help: "It read the world right" },
  { key: "action", label: "Actions", help: "No word, but it did something" },
];

const ago = (iso: string, now: number) => {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

/** What the post says and what really happened, in the feed's words. */
function summary(p: Post, flies: Map<string, Fly>): { headline: string; really: string } {
  const did = strongest(p.actions).map(actionText).join(" and ");
  const really = p.cause
    ? causeText(p.cause.channel, flies.get(p.cause.from_fly_id)?.name ?? "a neighbour", p.cause.strength)
    : WORDS[p.truth]?.really ?? p.truth;
  switch (p.kind) {
    case "hallucination": return { headline: line(p.word, false, p.id), really: "Hallucination: nothing was there" };
    case "misread": return { headline: line(p.word, false, p.id), really: `Misread: really ${really}` };
    case "action": return { headline: `*${did || "twitches"}*`, really: p.truth === "nothing" && !p.cause ? "No reason at all" : `Because of ${really}` };
    default: return { headline: line(p.word, true, p.id), really: `Read it right: ${really}` };
  }
}

/**
 * My flies: every post of the signed-in person's flies in one list, with filters for the meme-worthy ones and a
 * Make meme button on each. Shows today's meme allowance and the memes already made.
 */
export default function MyFlies({ allFlies, patches, viewer, now, memeTick, onMeme, onFly }: {
  allFlies: Fly[]; patches: Map<string, Patch>; viewer: Viewer; now: number; memeTick: number;
  onMeme: (post: Post) => void; onFly: (id: string) => void;
}) {
  const mine = viewer ? allFlies.filter((f) => f.owner === viewer.userId) : [];
  const ids = mine.map((f) => f.id).sort().join(",");
  const byId = new Map(allFlies.map((f) => [f.id, f]));
  const [flyFilter, setFlyFilter] = useState<string>("all");
  const [kind, setKind] = useState<Filter>("all");
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<MemeQuota | null>(null);
  const [memes, setMemes] = useState<Meme[]>([]);

  useEffect(() => {
    if (!viewer || !ids) return;
    setPosts(null);
    setError(null);
    const chosen = flyFilter === "all" ? ids.split(",") : [flyFilter];
    loadFlyPosts(chosen, { kind: kind === "all" ? undefined : kind })
      .then(setPosts)
      .catch((e) => setError(e?.message ?? String(e)));
  }, [viewer?.userId, ids, flyFilter, kind]);
  useEffect(() => {
    if (!viewer?.ready) return;
    getMemeQuota().then(setQuota).catch(() => setQuota(null));
    loadMemes({ userId: viewer.userId, limit: 30 }).then(setMemes);
  }, [viewer?.userId, viewer?.ready, memeTick]);

  if (!viewer) {
    return <div className="mine-tab"><div className="empty">Sign in to see all your flies' posts here and make memes from them.</div></div>;
  }
  if (mine.length === 0) {
    return (
      <div className="mine-tab">
        <div className="empty">You don't have a fly yet. <a href="#account">Hatch one</a>, and its posts show up here.</div>
      </div>
    );
  }

  const canMake = !!quota?.holder && quota.left_today > 0 && quota.global_left > 0;
  const status = !quota ? "Checking today's meme…"
    : !quota.holder ? "Hold $FLYAI to make memes: 1 a day from any of these posts."
    : quota.global_left < 1 ? "Flybook's meme machine is out of paint for today. Back at 00:00 UTC."
    : quota.left_today > 0 ? "You have 1 meme to make today. Pick a post: hallucinations make the funniest ones."
    : "Today's meme is made. The next one unlocks at 00:00 UTC.";

  return (
    <div className="mine-tab">
      <div className="feed-head">
        <h2>My flies</h2>
        <p>Every post from your {mine.length === 1 ? "fly" : `${mine.length} flies`}, newest first.</p>
      </div>
      <div className={`card meme-status${canMake ? " ready" : ""}`}>🎨 {status}</div>

      <div className="board-controls">
        <div className="seg">
          <button className={flyFilter === "all" ? "on" : ""} onClick={() => setFlyFilter("all")}>All my flies</button>
          {mine.map((f) => (
            <button key={f.id} className={flyFilter === f.id ? "on" : ""} onClick={() => setFlyFilter(f.id)}>
              <span className="dot" style={{ background: f.color }} /> {f.name}
            </button>
          ))}
        </div>
        <div className="seg">
          {FILTERS.map((x) => (
            <button key={x.key} className={kind === x.key ? "on" : ""} title={x.help} onClick={() => setKind(x.key)}>{x.label}</button>
          ))}
        </div>
      </div>

      {error && <p className="err">{error}</p>}
      {posts === null && !error && <div className="empty">Loading your flies' posts…</div>}
      {posts !== null && posts.length === 0 && <div className="empty">No posts like that yet. The next tick is on its way.</div>}
      {posts !== null && posts.length > 0 && (
        <ul className="mine-posts">
          {posts.map((p) => {
            const fly = byId.get(p.fly_id);
            const s = summary(p, byId);
            return (
              <li key={p.id} className={`mine-post kind-${p.kind}`}>
                <div className="mine-main">
                  <div className="mine-top">
                    <button className="who" onClick={() => onFly(p.fly_id)}>
                      <span className="dot" style={{ background: fly?.color ?? "#888" }} />
                      {fly?.name ?? "a fly"}
                    </button>
                    <span className={`badge kind-badge kind-${p.kind}`}>{FILTERS.find((x) => x.key === p.kind)?.label.replace(/s$/, "") ?? p.kind}</span>
                    <span className="where">in {patches.get(p.patch_id)?.name ?? p.patch_id}</span>
                    <span className="when">{ago(p.created_at, now)}</span>
                  </div>
                  <p className="says">{s.headline}</p>
                  <p className="fine">{s.really}{p.actions.length ? ` · ${strongest(p.actions).map(actionText).join(", ")}` : ""}</p>
                </div>
                <button className="btn red meme-make" disabled={!canMake} onClick={() => onMeme(p)}
                        title={canMake ? "Turn this post into an AI image meme" : status}>
                  🎨 Make meme
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {memes.length > 0 && (
        <div className="meme-gallery mine-memes">
          <h5>Your memes</h5>
          <div className="meme-strip">
            {memes.map((m) => (
              <a key={m.id} href={`#meme-${m.id}`} onClick={(e) => { e.preventDefault(); window.open(memeImage(m), "_blank", "noopener"); }}
                 title={`${m.top_text} / ${m.bottom_text} · ${m.likes_all ?? 0} likes`}>
                <img src={memeImage(m)} alt={m.top_text} loading="lazy" />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
