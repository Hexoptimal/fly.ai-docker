/**
 * Flinder's silly effects over the phone: emoji confetti, shakes, crickets, the chat's big finishes and the
 * swatter jump scare. All cosmetic: nothing here decides anything.
 */
import type { Ending, Reply } from "./readout.ts";
import { t } from "./i18n.ts";

const anyOf = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];

export class Fx {
  constructor(private readonly phone: HTMLElement, private readonly speed: () => number) {}

  private wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms / this.speed())); }

  /** Where an element's centre is on the phone. */
  at(el: Element): { x: number; y: number } {
    const r = el.getBoundingClientRect(), p = this.phone.getBoundingClientRect();
    return { x: r.left - p.left + r.width / 2, y: r.top - p.top + r.height / 2 };
  }

  /** Emoji confetti from a point on the phone (px, relative to it). */
  burst(emojis: string[], n: number, x: number, y: number, spread = 140): void {
    for (let k = 0; k < n; k++) {
      const el = document.createElement("span");
      el.className = "pt";
      el.textContent = anyOf(emojis);
      const a = Math.random() * Math.PI * 2, d = spread * (0.4 + Math.random() * 0.6);
      el.style.left = `${x}px`; el.style.top = `${y}px`;
      el.style.setProperty("--dx", `${Math.cos(a) * d}px`);
      el.style.setProperty("--dy", `${Math.sin(a) * d - 40}px`);
      el.style.setProperty("--r", `${(Math.random() - 0.5) * 540}deg`);
      el.style.animationDuration = `${(0.8 + Math.random() * 0.5) / this.speed()}s`;
      this.phone.appendChild(el);
      el.addEventListener("animationend", () => el.remove());
    }
  }

  shake(el: HTMLElement = this.phone, cls = "shake"): void {
    el.classList.remove(cls);
    void el.offsetWidth;                                 // restart the animation
    el.classList.add(cls);
    el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
  }

  /** A critter that hops across the phone once (crickets for an awkward silence). */
  runAcross(emoji: string, y: number): void {
    const el = document.createElement("span");
    el.className = "runner";
    el.innerHTML = `<i>${emoji}</i>`;
    el.style.top = `${y}px`;
    el.style.animationDuration = `${2.4 / this.speed()}s`;
    this.phone.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
  }

  /** Each kind of message gets its own little show. */
  message(el: HTMLElement, kind: Reply, strong: boolean): void {
    const c = this.at(el);
    if (kind === "flirt" && strong) { el.classList.add("hot"); this.burst(["🔥", "😍", "💘"], 8, c.x, c.y, 110); this.shake(this.phone, "pulse"); }
    else if (kind === "flirt") this.burst(["💕", "😘", "✨"], 4, c.x, c.y, 70);
    else if (kind === "spooked") { el.classList.add("spook"); this.burst(["💨", "😱", "💨"], 7, c.x, c.y, 130); this.shake(); }
    else if (kind === "groom") { el.classList.add("groom"); this.burst(["🫧", "🫧", "🧼"], 7, c.x, c.y, 90); }
    else this.runAcross("🦗", c.y + 20);
  }

  /** The big finish of a chat: ghost, broken heart, a date or still texting. */
  async ending(end: Ending, faded: HTMLElement, pics: [string, string]): Promise<void> {
    const ov = document.createElement("div");
    ov.className = `fx-ov fx-${end}`;
    if (end === "ghosted") {
      faded.classList.add("faded");
      ov.innerHTML = `<span class="big ghost">👻</span><span class="fx-stamp">${t("flinder.fx.ghosted")}</span>`;
    } else if (end === "unmatched") {
      ov.innerHTML = `<span class="heartbreak"><i>❤️</i><i>❤️</i></span><span class="fx-stamp">${t("flinder.fx.unmatched")}</span>`;
      this.shake();
    } else if (end === "date") {
      ov.innerHTML = `<span class="kiss"><img alt=""><b>💋</b><img alt=""></span><span class="fx-stamp">${t("flinder.fx.date")}</span>`;
      const [a, b] = ov.querySelectorAll("img");
      a.src = pics[0]; b.src = pics[1];
      const x = this.phone.clientWidth / 2, y = this.phone.clientHeight / 2;
      for (let k = 0; k < 3; k++) setTimeout(() => this.burst(["🍌", "🪰", "💖", "🎉", "🍷"], 10, x, y, 180), k * 350 / this.speed());
    } else {
      ov.innerHTML = `<span class="big">💬</span><span class="fx-stamp">${t("flinder.fx.texting")}</span>`;
    }
    this.phone.appendChild(ov);
    await this.wait(2300);
    ov.remove();
  }

  /** A stamp across the top card (SUPER LIKE). */
  async stamp(text: string, cls: string): Promise<void> {
    const ov = document.createElement("div");
    ov.className = `fx-ov fx-${cls}`;
    ov.innerHTML = `<span class="fx-stamp"></span>`;
    ov.querySelector(".fx-stamp")!.textContent = text;
    this.phone.appendChild(ov);
    await this.wait(900);
    ov.remove();
  }

  /** Jump scare: a rolled-up newspaper slams the screen. */
  async swatter(): Promise<void> {
    const ov = document.createElement("div");
    ov.className = "fx-ov fx-swat";
    ov.innerHTML = `<span class="paper">🗞️</span><span class="fx-stamp">${t("flinder.fx.swat")}</span><small>${t("flinder.fx.swatSub")}</small>`;
    this.phone.appendChild(ov);
    await this.wait(250);
    this.shake();
    this.burst(["💥", "⭐", "💫"], 12, this.phone.clientWidth / 2, this.phone.clientHeight / 2, 170);
    await this.wait(1500);
    ov.remove();
  }
}
