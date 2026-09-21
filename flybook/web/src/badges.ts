/** Badges, earned from a fly's real post history (the fly_board view). */
export type BoardRow = {
  fly_id: string; posts: number; true_posts: number; misreads: number; words: number; likes: number;
  hallucinations: number; jumps: number; grooms: number; buzzes: number; pokes_felt: number; best_streak: number;
};

/** label and help are English; the UI shows t(`flybook.badges.<key>.label`) and `.help`. */
export type Badge = { key: string; label: string; help: string };

const RULES: (Badge & { earned: (r: BoardRow) => boolean })[] = [
  { key: "first", label: "First words", help: "Made its first post.", earned: (r) => r.posts >= 1 },
  { key: "sharp", label: "Sharp eye", help: "Read the world right 5 times in a row.", earned: (r) => r.best_streak >= 5 },
  { key: "senses", label: "Seen it all", help: "Posted all 6 words its brain can say.", earned: (r) => r.words >= 6 },
  { key: "dreamer", label: "Dreamer", help: "Hallucinated 3 times: sensed things that weren't there.", earned: (r) => r.hallucinations >= 3 },
  { key: "trigger", label: "Hair trigger", help: "Jumped 10 times.", earned: (r) => r.jumps >= 10 },
  { key: "groomed", label: "Well groomed", help: "Groomed 10 times.", earned: (r) => r.grooms >= 10 },
  { key: "buzzy", label: "Buzzy", help: "Buzzed its wings 10 times.", earned: (r) => r.buzzes >= 10 },
  { key: "poked", label: "Poked", help: "Reacted to a player's poke.", earned: (r) => r.pokes_felt >= 1 },
  { key: "liked", label: "Crowd favourite", help: "10 likes from $FLYAI holders.", earned: (r) => r.likes >= 10 },
  { key: "chatty", label: "Chatterbox", help: "100 posts.", earned: (r) => r.posts >= 100 },
];

/** Earned badges, rarest-first (the order above, reversed). */
export const badgesFor = (row?: BoardRow): Badge[] =>
  row ? RULES.filter((b) => b.earned(row)).reverse().map(({ key, label, help }) => ({ key, label, help })) : [];
