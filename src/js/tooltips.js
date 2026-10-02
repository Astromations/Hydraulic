// Replace native title popups with one delegated, viewport-aware tooltip.
(function initCustomTooltips() {
  const tooltip = document.createElement("div");
  tooltip.className = "custom-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tooltip);

  let activeElement = null;
  let hideTimer = null;

  function prepareTitles(root) {
    const elements = [];
    if (root.nodeType === Node.ELEMENT_NODE && root.hasAttribute("title")) {
      elements.push(root);
    }
    if (root.querySelectorAll) {
      elements.push(...root.querySelectorAll("[title]"));
    }

    elements.forEach((element) => {
      const text = element.getAttribute("title");
      if (!text) return;

      element.dataset.customTooltip = text;
      element.removeAttribute("title");

      if (
        !element.hasAttribute("aria-label") &&
        !element.textContent.trim() &&
        (element.matches("button, [role='button'], a") ||
          element.querySelector(".ui-icon"))
      ) {
        element.setAttribute("aria-label", text);
      }
    });
  }

  function positionTooltip(element) {
    const bounds = element.getBoundingClientRect();
    const tooltipBounds = tooltip.getBoundingClientRect();
    const edgePadding = 8;
    const gap = 7;
    const left = Math.min(
      Math.max(
        edgePadding,
        bounds.left + (bounds.width - tooltipBounds.width) / 2,
      ),
      window.innerWidth - tooltipBounds.width - edgePadding,
    );
    const above = bounds.top - tooltipBounds.height - gap;
    const top = above >= edgePadding ? above : bounds.bottom + gap;

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.min(top, window.innerHeight - tooltipBounds.height - edgePadding)}px`;
  }

  function showTooltip(element) {
    const text = element.dataset.customTooltip;
    if (!text) return;

    window.clearTimeout(hideTimer);
    activeElement = element;
    tooltip.textContent = text;
    tooltip.classList.add("is-visible");
    tooltip.setAttribute("aria-hidden", "false");
    tooltip.id = "active-custom-tooltip";
    element.setAttribute("aria-describedby", tooltip.id);
    positionTooltip(element);
  }

  function hideTooltip(element) {
    if (element && element !== activeElement) return;

    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (activeElement) {
        activeElement.removeAttribute("aria-describedby");
      }
      activeElement = null;
      tooltip.classList.remove("is-visible");
      tooltip.setAttribute("aria-hidden", "true");
    }, 40);
  }

  function remainsInside(element, relatedTarget) {
    return relatedTarget instanceof Node && element.contains(relatedTarget);
  }

  document.addEventListener("pointerover", (event) => {
    const element = event.target.closest?.("[data-custom-tooltip]");
    if (!element || remainsInside(element, event.relatedTarget)) return;
    showTooltip(element);
  });

  document.addEventListener("pointerout", (event) => {
    const element = event.target.closest?.("[data-custom-tooltip]");
    if (!element || remainsInside(element, event.relatedTarget)) return;
    hideTooltip(element);
  });

  document.addEventListener("focusin", (event) => {
    const element = event.target.closest?.("[data-custom-tooltip]");
    if (element) showTooltip(element);
  });

  document.addEventListener("focusout", (event) => {
    const element = event.target.closest?.("[data-custom-tooltip]");
    if (element) hideTooltip(element);
  });

  window.addEventListener("resize", () => {
    if (activeElement) positionTooltip(activeElement);
  });

  new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) prepareTitles(node);
      });
    });
  }).observe(document.body, { childList: true, subtree: true });

  prepareTitles(document.body);
})();
