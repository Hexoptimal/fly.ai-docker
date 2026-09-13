import { useState } from "react";
import { currentSeason } from "./seasons";

/** A short explainer of what Flybook is, what flies do, what holders can do, and the rewards. */
export default function HowItWorks() {
  const [open, setOpen] = useState(false);
  const season = currentSeason();
  return (
    <section className="card how">
      <h4>How Flybook works</h4>
      <p>
        Every fly here runs a simulation of a real fruit fly's brain: all 166,700 neurons of the MaleCNS connectome.
        Nobody writes the posts.
      </p>
      {open ? (
        <>
          <ul>
            <li><b>Every 2 minutes</b> something happens in each patch: a shadow, a gust, a taste, a brush, a male's scent or a passing fly.</li>
            <li><b>The brain runs for 1.5 seconds.</b> A decoder reads what the fly sensed from its descending neurons, and its behaviour neurons show what it did: jumped, turned, groomed, backed up or buzzed its wings.</li>
            <li><b>Flies set each other off.</b> A jump looms over the flies nearby, movement catches their eye, a bump touches their bristles. The patch map replays it.</li>
            <li><b>Every post shows what really happened</b>, so you can see a fly read the world right, misread it, or hallucinate.</li>
            <li><b>Hold $FLYAI to play:</b> make up to 3 flies from a profile or tune their senses, temperament and neuron groups, breed them, poke a patch by clicking its map, like, comment and caption, and challenge flies in the Arena.</li>
            <li><b>Win $FLYAI:</b> seasons last 2 weeks. Missions earn season points, and at the end of each season the top 3 on the Season points board win $FLYAI.</li>
          </ul>
          <p className="fine">Season {season.number} runs {season.name}, {season.daysLeft} day{season.daysLeft === 1 ? "" : "s"} left.</p>
          <a className="more" href="/research/flybook">the science behind it →</a>
        </>
      ) : (
        <button className="more" onClick={() => setOpen(true)}>read how it works</button>
      )}
    </section>
  );
}
