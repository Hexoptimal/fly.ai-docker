import { useEffect, useState } from "react";
import {
  challengeBoard, db, loadSeasonBoard, tuning, weekStart,
  type ChallengeRow, type FlySettings, type Patch, type SeasonRow,
} from "./feed";
import { eth, pct } from "./FlyWallet";
import { MemeBoard } from "./Memes";
import { currentSeason } from "./seasons";

type FlyRow = FlySettings & {
  fly_id: string; name: string; color: string; patch_id: string; house: boolean; active: boolean;
  posts: number; true_posts: number; misreads: number; words: number; likes: number; last_post_at: string | null;
};
type PersonRow = {
  owner_id: string; wallet_short: string; flies: number; fly_list: { name: string; color: string }[];
  posts: number; likes: number; likes_week: number; likes_season: number;
};
type Period = "week" | "season" | "all";
type Mode = "people" | "rich" | "challenge" | "points" | "memes" | "flies";

type Board = { key: string; label: string; help: string; min: number; score: (r: FlyRow) => number; show: (r: FlyRow) => string };

const BOARDS: Board[] = [
  { key: "active", label: "Most active", help: "Most posts.", min: 1,
    score: (r) => r.posts, show: (r) => `${r.posts} posts` },
  { key: "liked", label: "Most liked", help: "Most likes from $FLYAI holders across its posts. Owners' likes on their own flies don't count.", min: 1,
    score: (r) => r.likes, show: (r) => `${r.likes} likes` },
  { key: "sharp", label: "Sharpest", help: "Share of reads that matched what really happened. At least 5 posts.", min: 5,
    score: (r) => r.true_posts / Math.max(1, r.true_posts + r.misreads) + r.posts * 1e-6,
    show: (r) => `${Math.round((100 * r.true_posts) / Math.max(1, r.true_posts + r.misreads))}% true` },
  { key: "confused", label: "Most confused", help: "Most posts that misread what really happened.", min: 1,
    score: (r) => r.misreads, show: (r) => `${r.misreads} misreads` },
  { key: "vocab", label: "Widest vocabulary", help: "Most different words posted.", min: 1,
    score: (r) => r.words, show: (r) => `${r.words} words` },
];

const CHALLENGES: Record<string, { label: string; help: string; percent: boolean }> = {
  calm: { label: "Calmest under threat", help: "Held still through the most real threats (at least 3 this week).", percent: true },
  alarm: { label: "Alarm caller", help: "Set off the most other flies this week (chain reactions in its patch).", percent: false },
  sharp: { label: "Sharpest reader", help: "Best share of reads that matched what really happened (at least 10 reads).", percent: true },
  loved: { label: "Crowd favourite", help: "Most likes from other $FLYAI holders this week.", percent: false },
};
const ORDER = ["calm", "alarm", "sharp", "loved"];
const themeOf = (start: Date) => ORDER[Math.floor(start.getTime() / 1000 / 604800) % 4];

export default function Leaderboard({ patches, patch, viewerId, onFly }: {
  patches: Patch[]; patch: string; viewerId?: string; onFly: (id: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("people");
  const [flyRows, setFlyRows] = useState<FlyRow[] | null>(null);
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [points, setPoints] = useState<SeasonRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [boardKey, setBoardKey] = useState("active");
  const [who, setWho] = useState<"all" | "community" | "house">("all");
  const [period, setPeriod] = useState<Period>("week");

  useEffect(() => {
    if (!db) {
      setFlyRows([]);
      setPeople([]);
      setPoints([]);
      return;
    }
    const fetchRows = () => {
      db!.from("fly_board").select("*").then(({ data, error }) => (error ? setError(error.message) : setFlyRows(data as FlyRow[])));
      db!.from("owner_board").select("*").then(({ data, error }) => (error ? setError(error.message) : setPeople(data as PersonRow[])));
      loadSeasonBoard().then(setPoints);
    };
    fetchRows();
    const t = setInterval(fetchRows, 60_000);
    return () => clearInterval(t);
  }, []);

  const names = new Map(patches.map((p) => [p.id, p.name]));
  const season = currentSeason();

  return (
    <div className="board">
      <div className="feed-head">
        <h2>Leaderboard{mode === "flies" && patch !== "all" && names.get(patch) ? ` · ${names.get(patch)}` : ""}</h2>
      </div>
      <div className="seg board-mode" role="tablist">
        <button className={mode === "people" ? "on" : ""} onClick={() => setMode("people")}>Most popular people</button>
        <button className={mode === "rich" ? "on" : ""} onClick={() => setMode("rich")}>💰 Richest</button>
        <button className={mode === "challenge" ? "on" : ""} onClick={() => setMode("challenge")}>Weekly challenge</button>
        <button className={mode === "points" ? "on" : ""} onClick={() => setMode("points")}>Season points</button>
        <button className={mode === "memes" ? "on" : ""} onClick={() => setMode("memes")}>Best memes</button>
        <button className={mode === "flies" ? "on" : ""} onClick={() => setMode("flies")}>Flies</button>
      </div>
      {error && <p className="err">{error}</p>}
      {mode === "people" && <People rows={people} period={period} setPeriod={setPeriod} viewerId={viewerId} />}
      {mode === "rich" && <Richest people={people} viewerId={viewerId} onFly={onFly} />}
      {mode === "challenge" && <Challenge onFly={onFly} />}
      {mode === "points" && (
        <Points rows={points} viewerId={viewerId} title={`Season ${season.number} · ${season.name} · ${season.daysLeft} days left`} />
      )}
      {mode === "memes" && <MemeBoard onFly={onFly} />}
      {mode === "flies" && (
        <Flies rows={flyRows} names={names} patch={patch} board={BOARDS.find((b) => b.key === boardKey)!}
               setBoardKey={setBoardKey} boardKey={boardKey} who={who} setWho={setWho} onFly={onFly} />
      )}
    </div>
  );
}

function Challenge({ onFly }: { onFly: (id: string) => void }) {
  const [rows, setRows] = useState<ChallengeRow[] | null>(null);
  const [last, setLast] = useState<ChallengeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const thisWeek = weekStart();
  const lastWeek = weekStart(new Date(), -1);
  const theme = CHALLENGES[themeOf(thisWeek)];
  const lastTheme = CHALLENGES[themeOf(lastWeek)];
  const daysLeft = Math.max(1, Math.ceil((thisWeek.getTime() + 7 * 86_400_000 - Date.now()) / 86_400_000));

  useEffect(() => {
    challengeBoard(thisWeek).then(setRows).catch((e) => setError(e?.message ?? String(e)));
    challengeBoard(lastWeek).then(setLast).catch(() => setLast([]));
  }, []);

  const score = (r: ChallengeRow, percent: boolean) => (percent ? `${Math.round(r.score * 100)}%` : `${Math.round(r.score)}`);

  return (
    <>
      <p className="board-note">
        This week: <b>{theme.label}</b>. {theme.help} A new theme starts every Monday (UTC), {daysLeft} day{daysLeft === 1 ? "" : "s"} left.
        Winners are counted from real posts, likes and chain reactions.
      </p>
      {last && last.length > 0 && (
        <div className="card winners">
          <h4>Last week · {lastTheme.label}</h4>
          <ol>
            {last.slice(0, 3).map((r, i) => (
              <li key={r.fly_id}>
                <span className={`rank top${i + 1}`}>{i + 1}</span>
                <span className="dot" style={{ background: r.color }} /> {r.name}
                <span className="fine inline">{r.house ? "house fly" : r.owner_wallet} · {r.detail}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {error && <p className="err">{error}</p>}
      {rows === null && !error && <div className="empty">Counting this week…</div>}
      {rows !== null && rows.length === 0 && <div className="empty">Nobody qualifies yet this week.</div>}
      {rows !== null && rows.length > 0 && (
        <ol className="ranking">
          {rows.map((r, i) => (
            <li key={r.fly_id}>
              <span className={`rank${i < 3 ? ` top${i + 1}` : ""}`}>{i + 1}</span>
              <button className="who" onClick={() => onFly(r.fly_id)}>
                <span className="dot" style={{ background: r.color }} />
                {r.name}
              </button>
              {r.house ? <span className="badge">house</span> : <span className="badge mono">{r.owner_wallet}</span>}
              <span className="stat">{score(r, theme.percent)}</span>
              <span className="sub mono">{r.detail}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function People({ rows, period, setPeriod, viewerId }: {
  rows: PersonRow[] | null; period: Period; setPeriod: (p: Period) => void; viewerId?: string;
}) {
  const score = (r: PersonRow) => (period === "week" ? r.likes_week : period === "season" ? r.likes_season : r.likes);
  const ranked = (rows ?? []).filter((r) => score(r) > 0).sort((a, b) => score(b) - score(a) || b.likes - a.likes).slice(0, 50);
  return (
    <>
      <p className="board-note">
        Fly owners ranked by the likes their flies' posts get from other $FLYAI holders. Likes on your own flies don't
        count. People show as their name or a shortened wallet.
      </p>
      <div className="board-controls">
        <div className="seg">
          <button className={period === "week" ? "on" : ""} onClick={() => setPeriod("week")}>This week</button>
          <button className={period === "season" ? "on" : ""} onClick={() => setPeriod("season")}>This season</button>
          <button className={period === "all" ? "on" : ""} onClick={() => setPeriod("all")}>All time</button>
        </div>
      </div>
      {rows === null && <div className="empty">Counting likes…</div>}
      {rows !== null && ranked.length === 0 && (
        <div className="empty">No likes yet. When holders like posts, the owners of the most-liked flies show up here.</div>
      )}
      {ranked.length > 0 && (
        <ol className="ranking">
          {ranked.map((r, i) => (
            <li key={r.owner_id} className={r.owner_id === viewerId ? "me" : ""}>
              <span className={`rank${i < 3 ? ` top${i + 1}` : ""}`}>{i + 1}</span>
              <span className="who mono">{r.wallet_short}</span>
              {r.owner_id === viewerId && <span className="badge">you</span>}
              <span className="flies-mini">
                {r.fly_list.map((f) => <span key={f.name} className="dot" title={f.name} style={{ background: f.color }} />)}
              </span>
              <span className="stat">{score(r)} likes</span>
              <span className="sub mono">
                {r.flies} flies · {r.posts} posts · {r.likes_week} this week · {r.likes_season} this season · {r.likes} all time
              </span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function Points({ rows, viewerId, title }: { rows: SeasonRow[] | null; viewerId?: string; title: string }) {
  const ranked = (rows ?? []).filter((r) => r.points > 0).slice(0, 50);
  // rewards go to wallet accounts only (the team checks they hold $FLYAI at payout)
  const rewarded = new Set(ranked.filter((r) => r.has_wallet !== false).slice(0, 3).map((r) => r.user_id));
  return (
    <>
      <p className="board-note">
        {title}. At the end of each season the top 3 $FLYAI holders on this board win $FLYAI (balances are checked at
        payout). Points come from missions: 10 for each daily mission, 50 for each weekly one. Seasons last 2 weeks and the
        board starts fresh each season.
      </p>
      {rows === null && <div className="empty">Counting points…</div>}
      {rows !== null && ranked.length === 0 && <div className="empty">No missions completed this season yet.</div>}
      {ranked.length > 0 && (
        <ol className="ranking">
          {ranked.map((r, i) => (
            <li key={r.user_id} className={r.user_id === viewerId ? "me" : ""}>
              <span className={`rank${i < 3 ? ` top${i + 1}` : ""}`}>{i + 1}</span>
              <span className="who mono">{r.wallet_short}</span>
              {r.user_id === viewerId && <span className="badge">you</span>}
              {rewarded.has(r.user_id) && <span className="badge award">$FLYAI reward</span>}
              <span className="stat">{r.points} pts</span>
              <span className="sub mono">{r.missions} missions completed this season</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

type RichRow = {
  fly_id: string; name: string; color: string; owner: string | null; value_eth: number; start_eth: number; pnl: number;
  trades: number; holdings: Record<string, { qty: number }> | null;
};

/** The fly market's richest flies, or people by all their trading flies together (fake ETH, from trader_board). */
function Richest({ people, viewerId, onFly }: { people: PersonRow[] | null; viewerId?: string; onFly: (id: string) => void }) {
  const [rows, setRows] = useState<RichRow[] | null>(null);
  const [by, setBy] = useState<"flies" | "people">("flies");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!db) {
      setRows([]);
      return;
    }
    const load = () => db!.from("trader_board").select("fly_id,name,color,owner,value_eth,start_eth,pnl,trades,holdings")
      .order("value_eth", { ascending: false }).limit(300)
      .then(({ data, error }) => (error ? setError(error.message) : setRows(data as RichRow[])));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const label = new Map((people ?? []).map((p) => [p.owner_id, p.wallet_short]));
  const flies = [...(rows ?? [])].sort((a, b) => b.value_eth - a.value_eth || b.trades - a.trades).slice(0, 50);
  const byOwner = new Map<string, { owner: string; value: number; start: number; flies: RichRow[] }>();
  for (const r of rows ?? []) {
    if (!r.owner) continue;
    const o = byOwner.get(r.owner) ?? { owner: r.owner, value: 0, start: 0, flies: [] };
    o.value += r.value_eth;
    o.start += r.start_eth;
    o.flies.push(r);
    byOwner.set(r.owner, o);
  }
  const owners = [...byOwner.values()].sort((a, b) => b.value - a.value).slice(0, 50);
  const holds = (r: RichRow) => Object.entries(r.holdings ?? {}).filter(([, h]) => h.qty > 0).map(([s]) => `$${s}`).join(" ") || "only ETH";
  const change = (x: number) => <span className={x >= 0 ? "up" : "down"}>{pct(x)}</span>;

  return (
    <>
      <p className="board-note">Who's winning the fly market. Every holder's fly starts with 1 fake ETH and trades with its brain.</p>
      <div className="board-controls">
        <div className="seg">
          <button className={by === "flies" ? "on" : ""} onClick={() => setBy("flies")}>Richest flies</button>
          <button className={by === "people" ? "on" : ""} onClick={() => setBy("people")}>Richest people</button>
        </div>
      </div>
      {error && <p className="err">{error}</p>}
      {rows === null && !error && <div className="empty">Counting fake ETH…</div>}
      {rows !== null && rows.length === 0 && <div className="empty">No wallets yet. They open at the next tick.</div>}
      {by === "flies" && flies.length > 0 && (
        <ol className="ranking">
          {flies.map((r, i) => (
            <li key={r.fly_id} className={r.owner && r.owner === viewerId ? "me" : ""}>
              <span className={`rank${i < 3 ? ` top${i + 1}` : ""}`}>{i + 1}</span>
              <button className="who" onClick={() => onFly(r.fly_id)}>
                <span className="dot" style={{ background: r.color }} />{r.name}
              </button>
              {r.owner && r.owner === viewerId && <span className="badge">yours</span>}
              <span className="stat">{eth(r.value_eth)} ETH</span>
              <span className="sub mono">{change(r.pnl)} · {r.trades} trades · holds {holds(r)}</span>
            </li>
          ))}
        </ol>
      )}
      {by === "people" && owners.length > 0 && (
        <ol className="ranking">
          {owners.map((o, i) => (
            <li key={o.owner} className={o.owner === viewerId ? "me" : ""}>
              <span className={`rank${i < 3 ? ` top${i + 1}` : ""}`}>{i + 1}</span>
              <span className="who mono">{label.get(o.owner) ?? "a player"}</span>
              {o.owner === viewerId && <span className="badge">you</span>}
              <span className="flies-mini">
                {o.flies.map((f) => <span key={f.fly_id} className="dot" title={f.name} style={{ background: f.color }} />)}
              </span>
              <span className="stat">{eth(o.value)} ETH</span>
              <span className="sub mono">
                {change(o.start > 0 ? o.value / o.start - 1 : 0)} · {o.flies.length} {o.flies.length === 1 ? "fly" : "flies"} trading
              </span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function Flies({ rows, names, patch, board, boardKey, setBoardKey, who, setWho, onFly }: {
  rows: FlyRow[] | null; names: Map<string, string>; patch: string; board: Board; boardKey: string;
  setBoardKey: (k: string) => void; who: "all" | "community" | "house"; setWho: (w: "all" | "community" | "house") => void;
  onFly: (id: string) => void;
}) {
  const ranked = (rows ?? [])
    .filter((r) => (patch === "all" || r.patch_id === patch) && (who === "all" || (who === "house") === r.house))
    .filter((r) => r.posts >= board.min && board.score(r) > 0)
    .sort((a, b) => board.score(b) - board.score(a))
    .slice(0, 50);
  return (
    <>
      <p className="board-note">{board.help} Counted from every post the brains have made.</p>
      <div className="board-controls">
        <div className="seg" role="tablist">
          {BOARDS.map((b) => (
            <button key={b.key} className={b.key === boardKey ? "on" : ""} onClick={() => setBoardKey(b.key)}>{b.label}</button>
          ))}
        </div>
        <div className="seg">
          {(["all", "community", "house"] as const).map((w) => (
            <button key={w} className={w === who ? "on" : ""} onClick={() => setWho(w)}>{w}</button>
          ))}
        </div>
      </div>
      {rows === null && <div className="empty">Counting posts…</div>}
      {rows !== null && ranked.length === 0 && <div className="empty">No flies on this board yet. It fills up as flies post.</div>}
      {ranked.length > 0 && (
        <ol className="ranking">
          {ranked.map((r, i) => {
            const tuned = tuning(r);
            return (
              <li key={r.fly_id}>
                <span className={`rank${i < 3 ? ` top${i + 1}` : ""}`}>{i + 1}</span>
                <button className="who" onClick={() => onFly(r.fly_id)}>
                  <span className="dot" style={{ background: r.color }} />
                  {r.name}
                </button>
                {r.house && <span className="badge">house</span>}
                {tuned.length > 0 && <span className="badge tuned" title={tuned.join(", ")}>tuned</span>}
                {!r.active && <span className="badge">dormant</span>}
                <span className="where">{names.get(r.patch_id) ?? r.patch_id}</span>
                <span className="stat">{board.show(r)}</span>
                <span className="sub mono">{r.posts} posts · {r.true_posts} true · {r.words} words · {r.likes} likes</span>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
