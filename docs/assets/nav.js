/**
 * The site's nav menus (Research, Apps, $FLYAI), shared by every page: the docs pages, Fly Radio, Fly Roulette
 * and compute. Hover and keyboard focus open a menu in CSS; this lets a tap or click on its label toggle it
 * (phones have no hover), and closes it on an outside click or Escape.
 */
(function () {
  const menus = [...document.querySelectorAll("nav li.dd")];
  const close = (dd) => { dd.classList.remove("open"); dd.querySelector(".ddbtn").setAttribute("aria-expanded", "false"); };
  for (const dd of menus) {
    const btn = dd.querySelector(".ddbtn");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !dd.classList.contains("open");
      menus.forEach(close);
      if (open) { dd.classList.add("open"); btn.setAttribute("aria-expanded", "true"); }
    });
    dd.addEventListener("focusout", (e) => { if (!dd.contains(e.relatedTarget)) close(dd); });
  }
  document.addEventListener("click", (e) => menus.forEach((dd) => { if (!dd.contains(e.target)) close(dd); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") menus.forEach(close); });
})();
