import { useEffect, useState } from "react";
import { loadSeasonBoard, myMissions, type Mission } from "./feed";
import { currentSeason } from "./seasons";

/** Daily and weekly missions for the signed-in user, and where they stand this season. */
export default function Missions({ viewer }: { viewer: { userId: string } | null }) {
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [standing, setStanding] = useState<{ points: number; rank: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const season = currentSeason();

  useEffect(() => {
    if (!viewer) return;
    const refresh = () => {
      myMissions().then(setMissions).catch((e) => setError(e?.message ?? String(e)));
      loadSeasonBoard().then((rows) => {
        const i = rows.findIndex((r) => r.user_id === viewer.userId);
        setStanding({ points: i >= 0 ? rows[i].points : 0, rank: i >= 0 ? i + 1 : null });
      });
    };
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [viewer?.userId]);

  if (!viewer) {
    return (
      <section className="card missions">
        <h4>Missions · Season {season.number}</h4>
        <p>Sign in to take on daily and weekly missions. Seasons last 2 weeks, and the top 3 $FLYAI holders on the
          season board win $FLYAI.</p>
      </section>
    );
  }

  const group = (period: "daily" | "weekly") => (missions ?? []).filter((m) => m.period === period);
  return (
    <section className="card missions">
      <h4>Missions · Season {season.number}</h4>
      <p className="fine season-line">
        {season.name} · {season.daysLeft} day{season.daysLeft === 1 ? "" : "s"} left
        {standing && ` · you: ${standing.points} pts${standing.rank ? `, #${standing.rank}` : ""}`}
      </p>
      <p className="fine reward-line">The top 3 $FLYAI holders at the end of the season win $FLYAI.</p>
      {error && <p className="err">{error}</p>}
      {missions === null && !error && <p className="fine">Loading…</p>}
      {(["daily", "weekly"] as const).map((period) => (
        group(period).length > 0 && (
          <div key={period}>
            <h5>{period === "daily" ? "Today" : "This week"}</h5>
            <ul>
              {group(period).map((m) => {
                const done = m.progress >= m.target;
                return (
                  <li key={m.key} className={done ? "done" : ""}>
                    <span className="m-label">{done ? "✓ " : ""}{m.label}</span>
                    <span className="m-pts mono">+{m.points}</span>
                    <span className="bar"><i style={{ width: `${Math.min(100, (100 * m.progress) / m.target)}%` }} /></span>
                    <span className="m-count mono">{Math.min(m.progress, m.target)}/{m.target}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )
      ))}
    </section>
  );
}
