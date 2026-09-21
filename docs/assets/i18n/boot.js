/**
 * Loaded in <head> (a plain, blocking script) by pages with static text. If the saved language is not
 * English it hides the page until i18n.js has translated it, so English never flashes first; a timeout
 * shows the page anyway if the strings are slow or fail to load. English pages are left alone.
 */
(function () {
  var lang = null;
  try { lang = new URLSearchParams(location.search).get("lang") || localStorage.getItem("flyai.lang"); } catch (e) { /* storage off */ }
  if (!lang || lang === "en") return;
  var html = document.documentElement;
  html.lang = lang;
  html.classList.add("i18n-pending");
  var style = document.createElement("style");
  style.textContent = "html.i18n-pending body{visibility:hidden}";
  document.head.appendChild(style);
  setTimeout(function () { html.classList.remove("i18n-pending"); }, 2500);
})();
