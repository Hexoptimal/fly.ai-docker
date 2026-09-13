/** Sharing a post: a link, an X intent, and a card image drawn in the browser. */
export const postUrl = (id: number) => `https://flyaiworld.com/flybook/#post-${id}`;

export function shareOnX(text: string, id: number) {
  const intent = new URL("https://twitter.com/intent/tweet");
  intent.searchParams.set("text", text);
  intent.searchParams.set("url", postUrl(id));
  window.open(intent.toString(), "_blank", "noopener,noreferrer");
}

type Card = { id: number; name: string; color: string; patch: string; headline: string; detail: string; chips: string[] };

function wrap(g: CanvasRenderingContext2D, text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/)) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width > width && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  return lines;
}

/** Draw a 1200x630 card for the post and download it as a PNG. */
export async function saveCard(card: Card) {
  await document.fonts?.ready;
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 630;
  const g = c.getContext("2d")!;
  const display = '"Space Grotesk", Inter, system-ui, sans-serif';
  const mono = '"JetBrains Mono", ui-monospace, monospace';

  g.fillStyle = "#07090c";
  g.fillRect(0, 0, 1200, 630);
  const glow = g.createRadialGradient(1050, 40, 0, 1050, 40, 520);
  glow.addColorStop(0, "rgba(224,52,44,0.30)");
  glow.addColorStop(1, "rgba(224,52,44,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, 1200, 630);

  g.fillStyle = "#eef1f5";
  g.font = `700 34px ${display}`;
  g.fillText("flybook", 64, 92);
  g.fillStyle = "#ff5b4f";
  g.font = `500 18px ${mono}`;
  g.fillText("DECODED FROM A REAL FRUIT-FLY BRAIN", 214, 90);

  g.beginPath();
  g.arc(78, 170, 12, 0, Math.PI * 2);
  g.fillStyle = card.color;
  g.fill();
  g.fillStyle = "#eef1f5";
  g.font = `600 30px ${display}`;
  g.fillText(card.name, 102, 181);
  g.fillStyle = "#95a0ae";
  g.font = `400 24px ${display}`;
  g.fillText(`in ${card.patch}`, 110 + g.measureText(card.name).width + 40, 181);

  g.fillStyle = "#eef1f5";
  g.font = `700 60px ${display}`;
  wrap(g, card.headline, 1070, 3).forEach((l, i) => g.fillText(l, 64, 280 + i * 72));

  g.fillStyle = "#6cc4d8";
  g.font = `400 26px ${display}`;
  wrap(g, card.detail, 1070, 2).forEach((l, i) => g.fillText(l, 64, 470 + i * 36));

  let x = 64;
  g.font = `500 20px ${mono}`;
  for (const chip of card.chips.slice(0, 5)) {
    const w = g.measureText(chip).width + 28;
    if (x + w > 1136) break;
    g.fillStyle = "#11161e";
    g.strokeStyle = "#222a35";
    g.beginPath();
    g.roundRect(x, 540, w, 40, 8);
    g.fill();
    g.stroke();
    g.fillStyle = "#3ddc84";
    g.fillText(chip, x + 14, 567);
    x += w + 10;
  }

  g.fillStyle = "#5f6b7a";
  g.font = `400 18px ${mono}`;
  g.fillText("flyaiworld.com/flybook", 900, 610);

  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
  if (!blob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `flybook-post-${card.id}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
