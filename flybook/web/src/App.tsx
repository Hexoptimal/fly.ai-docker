import { useCallback, useEffect, useMemo, useState } from "react";
import Account from "./Account";
import Arena from "./Arena";
import HowItWorks from "./HowItWorks";
import Leaderboard from "./Leaderboard";
import Missions from "./Missions";
import PatchView from "./PatchView";
import { Caption, Comments } from "./PostSocial";
import { pokePatch, setLike } from "./api";
import { badgesFor, type Badge, type BoardRow } from "./badges";
import {
  BASE, fetchPost, likeCount, load, loadBoard, loadComments, loadFlies, loadPokes, loadPositions, loadReplays, myLikes,
  subscribe, tuning, type Duel, type Fly, type Patch, type Poke, type Post, type Replay, type Snapshot,
} from "./feed";
import { postUrl, saveCard, shareOnX } from "./share";
import { POKES, WORDS, actionText, causeText, joinActions, word } from "./words";

const SCIENCE_URL = "/research/flybook";
const SITE_URL = "/";
type View = "feed" | "board" | "arena";
type Viewer = { userId: string; holder: boolean } | null;

function ago(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const viewOf = (hash: string): View => (hash === "#leaderboard" ? "board" : hash === "#arena" ? "arena" : "feed");

/** A post's headline and detail line, from what the brain read, what the fly did, and what caused it. */
function describe(post: Post, flies: Map<string, Fly>): { headline: string; detail: string; tone: "ok" | "miss" | "dream" | "plain" } {
  const w = word(post.word);
  const did = post.actions?.length ? joinActions(post.actions) : "";
  const really = post.cause
    ? causeText(post.cause.channel, flies.get(post.cause.from_fly_id)?.name ?? "a neighbour")
    : WORDS[post.truth]?.really ?? post.truth;
  switch (post.kind) {
    case "hallucination":
      return { headline: w.says, detail: `Hallucination: nothing was there${did ? `, but it ${did}` : ""}.`, tone: "dream" };
    case "misread":
      return { headline: w.says, detail: `Misread: really ${really}${did ? `. It ${did}` : ""}.`, tone: "miss" };
    case "action":
      return {
        headline: `${cap(did)}.`,
        detail: post.cause ? `Reacting to ${really}.`
          : post.truth === "nothing" ? "Nothing happened. Its brain did this on its own." : `Really: ${really}. It didn't put a word to it.`,
        tone: "plain",
      };
    default:
      return { headline: w.says, detail: `Really: ${really}${did ? `. Then it ${did}` : ""}.`, tone: "ok" };
  }
}

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [patch, setPatch] = useState("all");
  const [flyId, setFlyId] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [now, setNow] = useState(Date.now());
  const [viewer, setViewer] = useState<Viewer>(null);
  const [liked, setLiked] = useState<Set<number>>(new Set());
  const [likeError, setLikeError] = useState<string | null>(null);
  const [board, setBoard] = useState<Map<string, BoardRow>>(new Map());
  const [pokes, setPokes] = useState<Poke[]>([]);
  const [pokeMsg, setPokeMsg] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [replays, setReplays] = useState<Map<string, { tickId: number; replay: Replay }>>(new Map());
  const [commentTicks, setCommentTicks] = useState<Map<number, number>>(new Map());
  const [liveDuel, setLiveDuel] = useState<Duel | null>(null);
  const [view, setView] = useState<View>(() => viewOf(location.hash));
  const [focus, setFocus] = useState<number | null>(() => {
    const m = location.hash.match(/^#post-(\d+)$/);
    return m ? Number(m[1]) : null;
  });

  useEffect(() => {
    if (!viewer) return setLiked(new Set());
    myLikes(viewer.userId).then(setLiked);
  }, [viewer?.userId]);

  useEffect(() => {
    const onHash = () => {
      const post = location.hash.match(/^#post-(\d+)$/);
      if (post) {
        setView("feed");
        setFocus(Number(post[1]));
      } else if (["#leaderboard", "#arena", "#feed"].includes(location.hash)) setView(viewOf(location.hash));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const reload = useCallback(() => {
    load().then(setSnap).catch((e) => setError(e?.message ?? String(e)));
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => {
    loadBoard().then(setBoard);
    loadPokes().then(setPokes);
    loadReplays().then(setReplays);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(
    () =>
      subscribe({
        onPost: (p) => {
          setSnap((s) => s && { ...s, posts: [p, ...s.posts.filter((x) => x.id !== p.id)].slice(0, 300) });
          setFresh((f) => new Set(f).add(p.id));
          setNow(Date.now());
        },
        onTick: (t) => {
          if (!t.finished_at) return;
          const { replay, ...rest } = t;
          setSnap((s) => s && { ...s, tick: rest });
          if (replay) {
            setReplays((m) => {
              const next = new Map(m);
              for (const [pid, r] of Object.entries(replay)) next.set(pid, { tickId: t.id, replay: r });
              return next;
            });
          }
          loadBoard().then(setBoard);
          loadPositions().then((where) =>
            setSnap((s) => s && { ...s, flies: s.flies.map((f) => (where.has(f.id) ? { ...f, ...where.get(f.id) } : f)) }),
          );
        },
        onLike: (postId) => {
          likeCount(postId).then((n) =>
            setSnap((s) => s && { ...s, posts: s.posts.map((p) => (p.id === postId ? { ...p, likes: n } : p)) }),
          );
        },
        onPoke: (poke) => setPokes((ps) => [poke, ...ps.filter((x) => x.id !== poke.id)].slice(0, 50)),
        onComment: (postId) => {
          loadComments(postId).then((items) =>
            setSnap((s) => s && { ...s, posts: s.posts.map((p) => (p.id === postId ? { ...p, comments: items.length } : p)) }),
          );
          setCommentTicks((m) => new Map(m).set(postId, (m.get(postId) ?? 0) + 1));
        },
        onCaption: (postId, body) =>
          setSnap((s) => s && { ...s, posts: s.posts.map((p) => (p.id === postId ? { ...p, caption: body } : p)) }),
        onDuel: (duel) => {
          setLiveDuel(duel);
          if (duel.status === "done") loadFlies().then((fs) => setSnap((s) => s && { ...s, flies: fs }));
        },
      }),
    [],
  );

  // a link to one post (#post-123): show everything, fetch it if it's older than the feed, scroll to it
  useEffect(() => {
    if (!snap || focus === null) return;
    const target = focus;
    const reveal = () => {
      setPatch("all");
      setFlyId(null);
      setFresh((f) => new Set(f).add(target));
      setTimeout(() => document.getElementById(`post-${target}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
      setFocus(null);
    };
    if (snap.posts.some((p) => p.id === target)) return reveal();
    fetchPost(target).then((p) => {
      if (p) setSnap((s) => s && { ...s, posts: [...s.posts, p].sort((a, b) => b.id - a.id) });
      reveal();
    });
  }, [!!snap, focus]);

  useEffect(() => setArmed(null), [patch]);

  const flies = useMemo(() => new Map((snap?.flies ?? []).map((f) => [f.id, f])), [snap?.flies]);
  const patches = useMemo(() => new Map((snap?.patches ?? []).map((p) => [p.id, p])), [snap?.patches]);
  const stats = useMemo(() => {
    const m = new Map<string, { reads: number; true: number }>();
    for (const p of snap?.posts ?? []) {
      if (p.correct === null || p.correct === undefined) continue;
      const s = m.get(p.fly_id) ?? { reads: 0, true: 0 };
      s.reads += 1;
      s.true += p.correct ? 1 : 0;
      m.set(p.fly_id, s);
    }
    return m;
  }, [snap?.posts]);

  if (error) return <Shell><div className="empty">Couldn't load the feed: {error}</div></Shell>;
  if (!snap) return <Shell><div className="empty">Waking the flies…</div></Shell>;

  const toggleLike = async (post: Post) => {
    if (!viewer?.holder) return;
    const want = !liked.has(post.id);
    const show = (likes: number, on: boolean) => {
      setLiked((l) => {
        const next = new Set(l);
        if (on) next.add(post.id);
        else next.delete(post.id);
        return next;
      });
      setSnap((s) => s && { ...s, posts: s.posts.map((p) => (p.id === post.id ? { ...p, likes } : p)) });
    };
    const before = post.likes ?? 0;
    show(Math.max(0, before + (want ? 1 : -1)), want);
    setLikeError(null);
    try {
      const res = await setLike(post.id, want);
      show(res.likes, res.liked);
    } catch (e) {
      show(before, !want);
      setLikeError(e instanceof Error ? e.message : String(e));
    }
  };

  const dropPoke = async (x: number, y: number) => {
    if (patch === "all" || !armed) return;
    setPokeMsg(null);
    try {
      await pokePatch(patch, armed, x, y);
      setPokeMsg("Poke sent. The flies near that spot feel it within a few seconds.");
      setArmed(null);
    } catch (e) {
      setPokeMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const shown = snap.posts.filter((p) => (patch === "all" || p.patch_id === patch) && (!flyId || p.fly_id === flyId));
  const activePatch = patches.get(patch);
  const activeFly = flyId ? flies.get(flyId) : undefined;
  const house = snap.flies.filter((f) => !f.owner);
  const community = snap.flies
    .filter((f) => f.owner && f.active !== false)
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .slice(0, 8);
  const waiting = pokes.filter((p) => p.patch_id === patch && !p.consumed_at);
  const patchFlies = snap.flies.filter((f) => f.patch_id === patch && f.active !== false);
  const shownReplay = replays.get(patch);

  const flyRow = (f: Fly) => {
    const s = stats.get(f.id);
    const earned = badgesFor(board.get(f.id));
    return (
      <li key={f.id}>
        <button onClick={() => { setFlyId(f.id); location.hash = "feed"; }} className={flyId === f.id ? "on" : ""}>
          <span className="dot" style={{ background: f.color }} />
          <span className="name">{f.name}</span>
          {earned.length > 0 && <span className="stars" title={earned.map((b) => b.label).join(", ")}>★{earned.length}</span>}
          <span className="rate" title="recent reads that matched what really happened · Elo rating">
            {s ? `${s.true}/${s.reads}` : "quiet"} · {f.elo ?? 1000}
          </span>
        </button>
      </li>
    );
  };

  return (
    <Shell live={snap.live}>
      <div className="layout">
        <aside className="patches">
          <h4>Patches</h4>
          <button className={patch === "all" ? "on" : ""} onClick={() => setPatch("all")}>Everywhere</button>
          {snap.patches.map((p) => (
            <button key={p.id} className={patch === p.id ? "on" : ""} onClick={() => { setPatch(p.id); if (view !== "feed") location.hash = "feed"; }}>
              {p.name}
              {pokes.some((x) => x.patch_id === p.id && !x.consumed_at) && <span className="pending-dot" title="a poke is on its way" />}
            </button>
          ))}
        </aside>

        <main className="feed">
          <div className="views" role="tablist">
            <a href="#feed" role="tab" aria-selected={view === "feed"} className={view === "feed" ? "on" : ""}>Feed</a>
            <a href="#arena" role="tab" aria-selected={view === "arena"} className={view === "arena" ? "on" : ""}>Arena</a>
            <a href="#leaderboard" role="tab" aria-selected={view === "board"} className={view === "board" ? "on" : ""}>Leaderboard</a>
          </div>
          {view === "board" && (
            <Leaderboard patches={snap.patches} patch={patch} viewerId={viewer?.userId}
                         onFly={(id) => { setFlyId(id); location.hash = "feed"; }} />
          )}
          {view === "arena" && <Arena flies={snap.flies} viewer={viewer} liveDuel={liveDuel} />}
          {view === "feed" && (
            <>
              <div className="feed-head">
                <h2>{activeFly ? activeFly.name : activePatch ? activePatch.name : "Everywhere"}</h2>
                <p>
                  {activeFly
                    ? `Generation ${activeFly.generation ?? 1} · Elo ${activeFly.elo ?? 1000} (${activeFly.wins ?? 0}-${activeFly.losses ?? 0}-${activeFly.draws ?? 0})` +
                      (activeFly.parents?.length ? ` · child of ${activeFly.parents.map((id) => flies.get(id)?.name ?? "a fly").join(" × ")}` : "")
                    : activePatch?.blurb ??
                      "Every post is read from a fruit-fly connectome's descending neurons: what it sensed, what it did, and what really happened. Flies in a patch set each other off."}
                </p>
                {activeFly && <button className="chip clear" onClick={() => setFlyId(null)}>show all flies ✕</button>}
                {snap.live && activePatch && !activeFly && (
                  <>
                    <PatchView flies={patchFlies} replay={shownReplay?.replay} tickId={shownReplay?.tickId}
                               waiting={waiting} armed={armed} onPoke={dropPoke} />
                    <div className="pokebar">
                      <span className="pokebar-label">Poke {activePatch.name}</span>
                      {POKES.map((pk) => (
                        <button key={pk.stimulus} className={`poke${armed === pk.stimulus ? " on" : ""}`} disabled={!viewer?.holder}
                                onClick={() => setArmed(armed === pk.stimulus ? null : pk.stimulus)}
                                title={viewer?.holder ? pk.hint : "Sign in with a wallet that holds $FLYAI to poke a patch"}>
                          {pk.label}
                        </button>
                      ))}
                      {armed && <span className="fine inline">Now click the map where it should land.</span>}
                      {waiting.length > 0 && <span className="fine inline">{waiting.length} poke{waiting.length > 1 ? "s" : ""} on the way…</span>}
                      {pokeMsg && <span className="fine inline">{pokeMsg}</span>}
                    </div>
                  </>
                )}
                {snap.live && !activePatch && !activeFly && (
                  <p className="fine">Pick a patch on the left to watch it live and poke it.</p>
                )}
              </div>
              {likeError && <p className="err">{likeError}</p>}
              {shown.length === 0 && <div className="empty">No posts here yet. The next tick is on its way.</div>}
              {shown.map((p) => (
                <PostCard key={p.id} post={p} flies={flies} patch={patches.get(p.patch_id)} now={now}
                          fresh={fresh.has(p.id)} onFly={setFlyId} liked={liked.has(p.id)} viewer={viewer}
                          onLike={() => toggleLike(p)} badges={badgesFor(board.get(p.fly_id))} commentTick={commentTicks.get(p.id) ?? 0}
                          parent={p.cause ? snap.posts.find((q) => q.tick_id === p.tick_id && q.fly_id === p.cause!.from_fly_id) : undefined} />
              ))}
            </>
          )}
        </main>

        <aside className="side">
          <Account patches={snap.patches} live={snap.live} onCreated={reload} onViewer={setViewer} house={house} />
          <HowItWorks />
          {snap.live && <Missions viewer={viewer} />}

          <section className="card">
            <h4>House flies</h4>
            <ul className="flies">{house.map(flyRow)}</ul>
            {community.length > 0 && (
              <>
                <h4 className="sub">New flies</h4>
                <ul className="flies">{community.map(flyRow)}</ul>
              </>
            )}
          </section>

          {snap.tick && (
            <section className="card">
              <h4>What flies can say</h4>
              <ul className="vocab">
                {Object.entries(snap.tick.translator.precision)
                  .filter(([w]) => w !== "nothing")
                  .sort((a, b) => b[1] - a[1])
                  .map(([w, q]) => (
                    <li key={w} className={snap.tick!.translator.postable.includes(w) ? "" : "muted"}>
                      <span className="chip">{word(w).tag}</span>
                      <span className="bar"><i style={{ width: pct(q) }} /></span>
                      <span className="mono">{pct(q)}</span>
                    </li>
                  ))}
              </ul>
              <p className="fine">
                Held-out decoder precision for each word. What flies do (jumped, turned, groomed, buzzed its wings) is read from
                behaviour neurons firing at least 3σ above rest. Tick #{snap.tick.id}: {snap.tick.flies} flies, {snap.tick.posts} posts.
              </p>
            </section>
          )}
        </aside>
      </div>
    </Shell>
  );
}

function PostCard({ post, flies, patch, now, fresh, onFly, liked, viewer, onLike, badges, parent, commentTick }: {
  post: Post; flies: Map<string, Fly>; patch?: Patch; now: number; fresh: boolean; onFly: (id: string) => void;
  liked: boolean; viewer: Viewer; onLike: () => void; badges: Badge[]; parent?: Post; commentTick: number;
}) {
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [talking, setTalking] = useState(false);
  const [copied, setCopied] = useState(false);
  const fly = flies.get(post.fly_id);
  const w = word(post.word);
  const d = describe(post, flies);
  const read = post.word !== "nothing";
  const poke = post.poke_id ? POKES.find((pk) => pk.stimulus === post.truth) : undefined;
  const name = fly?.name ?? "A fly";
  const source = post.cause ? flies.get(post.cause.from_fly_id) : undefined;
  const chips = [...(read ? [w.tag] : []), ...(post.actions ?? []).map(actionText)];
  const canLike = !!viewer?.holder;

  return (
    <article id={`post-${post.id}`} className={`post kind-${post.kind ?? "sense"}${post.cause ? " caused" : ""}${fresh ? " fresh" : ""}`}>
      <header>
        <button className="who" onClick={() => onFly(post.fly_id)}>
          <span className="dot" style={{ background: fly?.color ?? "#888" }} />
          {name}
        </button>
        {fly && !fly.owner && <span className="badge">house</span>}
        {fly && tuning(fly).length > 0 && <span className="badge tuned" title={tuning(fly).join(", ")}>tuned</span>}
        {badges.slice(0, 2).map((b) => <span key={b.key} className="badge award" title={b.help}>{b.label}</span>)}
        <span className="where">in {patch?.name ?? post.patch_id}</span>
        <span className="when">{ago(post.created_at, now)}</span>
      </header>
      {poke && <p className="poked">After a holder's poke: {poke.done}</p>}
      {post.cause && (
        <p className="chain">
          ↳ set off by{" "}
          {parent ? <a href={`#post-${parent.id}`}>{source?.name ?? "a neighbour"}'s post</a> : <b>{source?.name ?? "a neighbour"}</b>}
        </p>
      )}
      <p className="says">{d.headline}</p>
      <p className={`did tone-${d.tone}`}>{d.detail}</p>
      <Caption post={post} isOwner={!!viewer && fly?.owner === viewer.userId} canWrite={canLike} />
      <div className="meta">
        {read && <span className="chip">{w.tag}</span>}
        {read && <span className="conf">decoder {pct(post.confidence)} sure</span>}
        {(post.actions ?? []).map((a) => (
          <span key={a.key} className="chip act" title={`${a.z}σ above a resting fly`}>{actionText(a)}</span>
        ))}
        <button className={`like${liked ? " on" : ""}`} onClick={onLike} disabled={!canLike} aria-pressed={liked}
                title={canLike ? (liked ? "Remove your like" : "Like this post") : "Sign in with a wallet that holds $FLYAI to like posts"}>
          {liked ? "♥" : "♡"} {post.likes ?? 0}
        </button>
        <button className="more talk" onClick={() => setTalking(!talking)} aria-expanded={talking}>💬 {post.comments ?? 0}</button>
        <button className="more" onClick={() => setSharing(!sharing)}>share</button>
        <button className="more" onClick={() => setOpen(!open)}>{open ? "hide neurons" : "neurons"}</button>
      </div>
      {talking && <Comments post={post} viewerId={viewer?.userId} canWrite={canLike} refreshKey={commentTick} />}
      {sharing && (
        <div className="share">
          <button className="btn sm" onClick={() => shareOnX(`${name} on Flybook: "${d.headline}" ${d.detail} Read from a real fruit-fly brain.`, post.id)}>
            Post on X
          </button>
          <button className="btn sm" onClick={() => saveCard({ id: post.id, name, color: fly?.color ?? "#888", patch: patch?.name ?? post.patch_id,
                                                             headline: d.headline, detail: d.detail, chips })}>
            Save card image
          </button>
          <button className="btn sm" onClick={() => navigator.clipboard?.writeText(postUrl(post.id)).then(() => setCopied(true))}>
            {copied ? "Link copied" : "Copy link"}
          </button>
        </div>
      )}
      {open && (
        <div className="neurons">
          {post.neurons.length === 0 && <span className="fine">No single descending-neuron type moved more than 2σ.</span>}
          {post.neurons.map((n) => (
            <span key={n.type} className={`chip ${n.z > 0 ? "up" : "down"}`}>
              {n.type} {n.z > 0 ? "+" : ""}{n.z}σ
            </span>
          ))}
          <span className="fine">
            {post.cause
              ? `Input from ${source?.name ?? "a neighbour"} (${post.cause.channel}, peak ${post.cause.strength} of a direct stimulus).`
              : `Stimulated: ${WORDS[post.truth]?.cells ?? post.truth}.`}{" "}
            Wings {post.wing_hz ?? "?"} spikes/s. Tick #{post.tick_id}.
            {fly && tuning(fly).length > 0 && ` Tuned: ${tuning(fly).join(", ")}.`}
          </span>
        </div>
      )}
    </article>
  );
}

function Shell({ children, live }: { children: React.ReactNode; live?: boolean }) {
  return (
    <>
      <nav>
        <div className="wrap">
          <a className="brand" href={BASE}>
            <img className="logo" src={`${BASE}logo.webp`} alt="" />
            flybook
            {live !== undefined && <span className={`status ${live ? "live" : ""}`}>{live ? "live" : "demo"}</span>}
          </a>
          <div className="links">
            <a href={SCIENCE_URL}>How it works</a>
            <a href={SITE_URL}>fly.ai</a>
            {live && <a className="btn red sm" href="#account">Make a fly</a>}
          </div>
        </div>
      </nav>
      <div className="wrap">{children}</div>
    </>
  );
}
