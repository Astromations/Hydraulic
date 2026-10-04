// ════════════════════════════════════════
// HYDRAULIC — Video Compressor  |  sliders.js
// ════════════════════════════════════════
// Slider initialization and settings reset.

function initSlider(id, labelId, fmt, min, max, snapPoints = []) {
  const slider = document.getElementById(id);
  if (!slider) return;
  const markerContainer = slider.parentElement?.querySelector(".slider-marks");
  const markers = markerContainer?.querySelectorAll("[data-value]") || [];

  function positionMarkers() {
    if (!markerContainer || markers.length === 0) return;
    const width = markerContainer.clientWidth;
    markers.forEach((marker) => {
      const value = parseFloat(marker.dataset.value);
      const position = Math.round(((value - min) / (max - min)) * width);
      marker.style.transform = `translateX(${position}px) translateX(-50%)`;
    });
  }

  function refresh() {
    if (min !== null) {
      const pct = ((slider.value - min) / (max - min)) * 100;
      slider.style.setProperty("--val", pct + "%");
    }
    if (labelId && fmt) {
      const label = document.getElementById(labelId);
      const value = parseFloat(slider.value);
      if (label instanceof HTMLInputElement) label.value = value;
      else label.textContent = fmt(value);
    }
    positionMarkers();
  }
  if (markerContainer && "ResizeObserver" in window) {
    new ResizeObserver(positionMarkers).observe(markerContainer);
  }
  slider.addEventListener("input", () => {
    const value = parseFloat(slider.value);
    const snapPoint = snapPoints.find((point) => Math.abs(point - value) <= 2);
    if (snapPoint !== undefined) slider.value = snapPoint;
    refresh();
  });
  const label = labelId && document.getElementById(labelId);
  if (label instanceof HTMLInputElement) {
    const updateFromLabel = () => {
      const rawValue = label.value.trim();
      const value = Number(rawValue);
      if (!/^[1-9]\d*$/.test(rawValue) || !Number.isSafeInteger(value)) {
        label.value = slider.value;
        return;
      }

      slider.value = Math.min(max, Math.max(min, value));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      label.value = rawValue;
    };
    label.addEventListener("change", updateFromLabel);
    label.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        label.blur();
      }
    });
  }
  refresh();
}

function resetSettings() {
  document.getElementById("sizeSlider").value = 20;
  document.getElementById("audioSlider").value = 128;
  document.getElementById("sizeSlider").dispatchEvent(new Event("input"));
  document.getElementById("audioSlider").dispatchEvent(new Event("input"));
  document.getElementById("gpuToggle").checked = false;
  document.getElementById("combineAudioToggle").checked = true;
  document.getElementById("twoPassToggle").checked = true;
  selectFmt(document.querySelector('.fmt-option[data-value="mp4"]'));
  document.getElementById("outputDirToggle").checked = false;
  document.getElementById("outputDirPicker").classList.remove("visible");
  document.getElementById("outputDirSubtitle").textContent =
    "Off — saves next to source file";
  customOutDir = null;
  if (typeof setPreviewMode === "function") {
    setPreviewMode("internal");
  }
  if (typeof saveSettings === "function") {
    saveSettings();
  }
}
