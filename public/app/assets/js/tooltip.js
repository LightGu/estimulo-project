/*
  Custom hover tooltip for any element with class="has-tip" and data-tip="...".
  Renders a single element appended to <body> with position:fixed, positioned via
  getBoundingClientRect at hover time, so it always sits above scroll/overflow containers
  (e.g. .table-wrap) instead of being clipped or forcing a scrollbar — unlike the native
  title attribute or a pure-CSS ::after tooltip confined to the trigger's own stacking context.
  Optional data-tip-tone="success|warning|danger|info|neutral" colors the bubble to match.
*/
(function () {
  let bubble = null;

  function ensureBubble() {
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "tooltip-bubble";
      document.body.appendChild(bubble);
    }
    return bubble;
  }

  function show(target) {
    const tip = target.dataset.tip;
    if (!tip) return;
    const el = ensureBubble();
    el.classList.remove("visible");
    el.className = `tooltip-bubble${target.dataset.tipTone ? ` tooltip-bubble--${target.dataset.tipTone}` : ""}`;
    el.textContent = tip;

    const targetRect = target.getBoundingClientRect();
    const bubbleRect = el.getBoundingClientRect();
    const left = Math.min(Math.max(targetRect.left + targetRect.width / 2, bubbleRect.width / 2 + 8), window.innerWidth - bubbleRect.width / 2 - 8);
    el.style.left = `${left}px`;
    el.style.top = `${targetRect.top - 10 - bubbleRect.height}px`;

    requestAnimationFrame(() => el.classList.add("visible"));
  }

  function hide() {
    if (bubble) bubble.classList.remove("visible");
  }

  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest(".has-tip");
    if (target) show(target);
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest(".has-tip")) hide();
  });
  document.addEventListener("focusin", (e) => {
    const target = e.target.closest(".has-tip");
    if (target) show(target);
  });
  document.addEventListener("focusout", (e) => {
    if (e.target.closest(".has-tip")) hide();
  });
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
})();
