/**
 * Shared page script.
 *
 * Set CONTRACT_ADDRESS and SWAP_URL once, at launch, and every page updates:
 * the CA boxes fill in, the copy button turns on, the "pre-launch" tags flip to
 * "live", and the buy links appear. Until then the page says plainly that the
 * token is not deployed and no buy link is shown, so there is nothing for a
 * scam address to hide behind.
 */

/** The deployed $FLYAI contract on Robinhood Chain. Empty until launch. */
const CONTRACT_ADDRESS = "0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C";

/**
 * Where to send people to buy it: the Pons / Robinhood Chain page for the
 * token. Paste the real URL here at launch - it is deliberately not guessed.
 */
const SWAP_URL = "https://www.ponsfamily.com/launchpad/0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C";

/** Blockscout page for the token on Robinhood Chain. */
const EXPLORER_URL = "https://robinhoodchain.blockscout.com/token/0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C";

const X_URL = "https://x.com/flydotai";
const GITHUB_URL = "https://github.com/alextitonis/fly.ai";

(function () {
  const set = (id, text, live) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (live) el.className = "v live";
  };

  if (CONTRACT_ADDRESS) {
    set("ca", CONTRACT_ADDRESS);
    set("ca-2", CONTRACT_ADDRESS, true);
    set("token-status", "live", true);
    const state = document.getElementById("chain-state");
    if (state) state.textContent = "live";

    const btn = document.getElementById("ca-copy");
    if (btn) {
      btn.disabled = false;
      btn.addEventListener("click", () => {
        navigator.clipboard.writeText(CONTRACT_ADDRESS).then(() => {
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = "Copy"), 1500);
        });
      });
    }
  }

  // the buy links only exist once there is an address to buy
  for (const host of document.querySelectorAll(".buylinks")) {
    if (CONTRACT_ADDRESS && SWAP_URL) {
      const a = document.createElement("a");
      a.className = "btn red";
      a.href = SWAP_URL;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Buy $FLYAI on Pons";
      host.prepend(a);
      if (EXPLORER_URL) {
        const ex = document.createElement("a");
        ex.className = "btn";
        ex.href = EXPLORER_URL;
        ex.target = "_blank";
        ex.rel = "noopener";
        ex.textContent = "View on explorer";
        a.after(ex);
      }
    } else {
      const p = document.createElement("p");
      p.className = "srcline";
      p.textContent = "Not deployed yet — the buy link appears here and on @flydotai at launch.";
      host.appendChild(p);
    }
  }
})();

// research dropdown: hover and keyboard focus open it in CSS; the caret button toggles it for touch
(function () {
  const menus = [...document.querySelectorAll("nav li.dd")];
  const close = (dd) => { dd.classList.remove("open"); dd.querySelector(".ddbtn").setAttribute("aria-expanded", "false"); };
  for (const dd of menus) {
    const btn = dd.querySelector(".ddbtn");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = dd.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
    });
    dd.addEventListener("focusout", (e) => { if (!dd.contains(e.relatedTarget)) close(dd); });
  }
  document.addEventListener("click", (e) => menus.forEach((dd) => { if (!dd.contains(e.target)) close(dd); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") menus.forEach(close); });
})();
