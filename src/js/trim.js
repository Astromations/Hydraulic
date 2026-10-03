// ════════════════════════════════════════
// PEAK — Video Compressor  |  trim.js
// ════════════════════════════════════════
// Trim modal: video preview, timeline, audio tracks, apply/close.

let trimItemId = null;
let trimItemPath = null;
let trimDuration = 0;
let trimIn = 0;
let trimOut = 0;
let trimDragging = null; // 'in' | 'out' | null
let trimAudioTracks = [];
let trimEnabledTracks = null; // null = all, or Set of indices (export selection)
let trimAudioVolumes = [];
let trimPreviewTmp = null; // temp file path created for mixed-audio preview
let playheadAnimationFrame = null;
let trimPreviewRefreshTimer = null;
const trimFrameDuration = 1 / 30;

const trimVideo = document.getElementById("trimVideo");
const tlTrack = document.getElementById("tlTrack");
const tlHandleIn = document.getElementById("tlHandleIn");
const tlHandleOut = document.getElementById("tlHandleOut");
const tlPlayhead = document.getElementById("tlPlayhead");
const tlSelection = document.getElementById("tlSelection");
const trimPrevBtn = document.getElementById("trimPrevBtn");
const trimNextBtn = document.getElementById("trimNextBtn");
const trimModalMenuBtn = document.getElementById("trimModalMenuBtn");
const trimItemMenu = document.getElementById("trimItemMenu");

function renderTrimItemMenu() {
  if (!trimItemMenu) return;
  trimItemMenu.innerHTML = "";

  queue.forEach((item) => {
    const button = document.createElement("button");
    button.className = "trim-item-menu-entry";
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.classList.toggle("active", item.id === trimItemId);
    button.addEventListener("click", async () => {
      closeTrimItemMenu();
      await openTrimModal(item.id);
    });

    const thumb = document.createElement("span");
    thumb.className = "trim-item-menu-thumb";
    if (item.thumbnail) {
      const image = document.createElement("img");
      image.src = item.thumbnail;
      image.alt = "";
      thumb.appendChild(image);
    } else {
      thumb.innerHTML = thumbPlaceholder();
      invoke("get_thumbnail", { filepath: item.path })
        .then((uri) => {
          item.thumbnail = uri || null;
          if (uri && trimItemMenu.contains(button)) {
            thumb.innerHTML = "";
            const image = document.createElement("img");
            image.src = uri;
            image.alt = "";
            thumb.appendChild(image);
          }
        })
        .catch(() => {});
    }

    const title = document.createElement("span");
    title.className = "trim-item-menu-title";
    title.textContent = item.name;
    button.append(thumb, title);
    trimItemMenu.appendChild(button);
  });
}

function openTrimItemMenu() {
  renderTrimItemMenu();
  trimItemMenu?.classList.add("open");
  trimModalMenuBtn?.setAttribute("aria-expanded", "true");
}

function closeTrimItemMenu() {
  trimItemMenu?.classList.remove("open");
  trimModalMenuBtn?.setAttribute("aria-expanded", "false");
}

function toggleTrimItemMenu() {
  if (trimItemMenu?.classList.contains("open")) closeTrimItemMenu();
  else openTrimItemMenu();
}

async function openTrimModal(id) {
  const item = queue.find((i) => i.id === id);
  if (!item) return;

  trimItemId = id;
  trimItemPath = item.path;
  trimIn = item.trimStart ? parseTimeJS(item.trimStart) : 0;
  trimOut = item.trimEnd ? parseTimeJS(item.trimEnd) : -1; // -1 = end (resolved after metadata)
  trimAudioTracks = item.audioTracks || [];
  trimEnabledTracks = item.enabledTracks ? new Set(item.enabledTracks) : null;
  trimAudioVolumes = item.audioVolumes || [];
  renderTrimItemMenu();
  updateTrimNavButtons();

  document.getElementById("trimModalTitle").textContent = item.name;

  // Reset UI to loading state — avoids showing stale -1:-1 values
  document.getElementById("trimTotalTime").textContent = "–:––";
  document.getElementById("trimCurrentTime").textContent = "0:00.00";
  document.getElementById("trimVideoError").classList.remove("show");

  // Reset timeline
  trimDuration = 0;
  tlHandleIn.style.left = "0%";
  tlHandleOut.style.left = "100%";
  tlSelection.style.left = "0%";
  tlSelection.style.width = "100%";
  tlPlayhead.style.left = "0%";
  tlTrack.style.setProperty("--trim-in", "0%");
  tlTrack.style.setProperty("--trim-out", "100%");
  renderTrackInfo();
  renderTimeRuler();

  document.getElementById("trimOverlay").classList.add("open");

  // If the file has multiple audio tracks, mix them down to a temp file first
  // so all tracks are audible simultaneously during preview (Chromium only
  // exposes one audio stream natively from a multi-track container).
  trimPreviewTmp = null;
  const result = await invoke("get_mixed_preview_url", {
    filepath: item.path,
    audioVolumes: trimAudioVolumes,
  });
  trimPreviewTmp = result.tmp; // null if single-track or fallback
  trimVideo.src = result.url ? convertFileSrc(result.url) : "";
  trimVideo.volume = trimAudioVolumes[0] ?? 1;
  trimVideo.load();

  // Fetch audio tracks if not yet loaded
  if (trimAudioTracks.length === 0) {
    invoke("get_audio_tracks", { filepath: item.path }).then((tracks) => {
      trimAudioTracks = tracks;
      item.audioTracks = tracks;
      renderAudioTracks();
      if (tracks.length === 1) trimVideo.volume = trimAudioVolumes[0] ?? 1;
    });
  } else {
    renderAudioTracks();
  }
}

trimVideo.addEventListener("loadedmetadata", () => {
  trimDuration =
    isFinite(trimVideo.duration) && trimVideo.duration > 0
      ? trimVideo.duration
      : 0;

  if (trimOut < 0 || trimOut > trimDuration) trimOut = trimDuration;
  if (trimIn > trimDuration) trimIn = 0;

  document.getElementById("trimTotalTime").textContent =
    fmtTimeHundredths(trimDuration);
  document.getElementById("trimVideoError").classList.remove("show");
  updateTimeline();
  renderTimeRuler();
  seekTrimVideo(trimIn);
});

trimVideo.addEventListener("error", () => {
  // Show error overlay if video truly fails to load
  document.getElementById("trimVideoError").classList.add("show");
});

trimVideo.addEventListener("timeupdate", () => {
  const t = trimVideo.currentTime;
  document.getElementById("trimCurrentTime").textContent = fmtTimeHundredths(t);
  updatePlayheadPosition(t);
  // Loop within trim range when playing
  if (!trimVideo.paused && t >= trimOut - 0.05) {
    trimVideo.currentTime = trimIn;
  }
});

trimVideo.addEventListener("play", updatePlayBtn);
trimVideo.addEventListener("pause", updatePlayBtn);

function updatePlayheadPosition(time) {
  if (trimDuration > 0) {
    tlPlayhead.style.left = (time / trimDuration) * 100 + "%";
  }
}

function animatePlayhead() {
  updatePlayheadPosition(trimVideo.currentTime);
  if (!trimVideo.paused) {
    playheadAnimationFrame = requestAnimationFrame(animatePlayhead);
  } else {
    playheadAnimationFrame = null;
  }
}

function syncPlayheadAnimation() {
  if (!trimVideo.paused && playheadAnimationFrame === null) {
    playheadAnimationFrame = requestAnimationFrame(animatePlayhead);
  } else if (trimVideo.paused && playheadAnimationFrame !== null) {
    cancelAnimationFrame(playheadAnimationFrame);
    playheadAnimationFrame = null;
  }
}

function updatePlayBtn() {
  const playing = !trimVideo.paused;
  syncPlayheadAnimation();
  const icon = document.getElementById("trimPlayBtn");
  icon.innerHTML = playing
    ? `<span class="ui-icon" data-icon="pause" aria-hidden="true"></span>`
    : `
<span class="ui-icon" data-icon="play" aria-hidden="true"></span>
`;
  showPlayOverlay(playing ? "pause" : "play");
}

function showPlayOverlay(type) {
  const overlay = document.getElementById("trimPlayOverlay");
  const icon = document.getElementById("trimPlayOverlayIcon");
  icon.innerHTML =
    type === "play"
      ? '<span class="ui-icon" data-icon="play" aria-hidden="true"></span>'
      : '<span class="ui-icon" data-icon="pause" aria-hidden="true"></span>';
  overlay.classList.add("show");
  setTimeout(() => overlay.classList.remove("show"), 500);
}

function toggleTrimPlay() {
  if (trimDuration <= 0) return;
  if (trimVideo.paused) {
    if (trimVideo.currentTime >= trimOut - 0.05) trimVideo.currentTime = trimIn;
    trimVideo.play();
  } else {
    trimVideo.pause();
  }
}

function skipVideo(secs) {
  trimVideo.currentTime = Math.max(
    0,
    Math.min(trimDuration, trimVideo.currentTime + secs),
  );
}

function stepTrimFrame(direction) {
  skipVideo(direction * trimFrameDuration);
}

function seekTrimVideo(t) {
  trimVideo.currentTime = Math.max(0, Math.min(trimDuration || 0, t));
}

function getTrimQueueIndex() {
  if (!trimItemId) return -1;
  return queue.findIndex((item) => item.id === trimItemId);
}

function updateTrimNavButtons() {
  const index = getTrimQueueIndex();
  if (trimPrevBtn) trimPrevBtn.disabled = index <= 0;
  if (trimNextBtn)
    trimNextBtn.disabled = index < 0 || index >= queue.length - 1;
}

async function navigateTrimClip(step) {
  const index = getTrimQueueIndex();
  const nextIndex = index + step;
  if (index < 0 || nextIndex < 0 || nextIndex >= queue.length) return;

  const target = queue[nextIndex];
  if (target) await openTrimModal(target.id);
}

function trimPrevClip() {
  navigateTrimClip(-1);
}

function trimNextClip() {
  navigateTrimClip(1);
}

function fmtTimeHundredths(s) {
  if (!isFinite(s) || s < 0) return "0:00.00";
  const minutes = Math.floor(s / 60);
  const seconds = (s % 60).toFixed(2).padStart(5, "0");
  return `${minutes}:${seconds}`;
}

// ── Timeline drag ─────────────────────────────────────────────────

function getTrackFrac(e) {
  const rect = tlTrack.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

tlTrack.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  tlTrack.setPointerCapture(e.pointerId);
  if (trimDuration <= 0) return;
  const frac = getTrackFrac(e);
  const inFrac = trimIn / trimDuration;
  const outFrac = trimOut / trimDuration;
  const hitZone = 0.03;

  if (Math.abs(frac - inFrac) < hitZone) {
    trimDragging = "in";
    tlHandleIn.classList.add("dragging");
  } else if (Math.abs(frac - outFrac) < hitZone) {
    trimDragging = "out";
    tlHandleOut.classList.add("dragging");
  } else {
    seekTrimVideo(frac * trimDuration);
  }
});

tlPlayhead.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (trimDuration <= 0) return;
  trimDragging = "playhead";
  tlPlayhead.classList.add("dragging");
  tlTrack.setPointerCapture(e.pointerId);
  seekTrimVideo(getTrackFrac(e) * trimDuration);
});

tlTrack.addEventListener("pointermove", (e) => {
  if (!trimDragging) return;
  const t = getTrackFrac(e) * trimDuration;
  if (trimDragging === "playhead") {
    seekTrimVideo(t);
  } else if (trimDragging === "in") {
    trimIn = Math.max(0, Math.min(t, trimOut - 0.1));
    seekTrimVideo(trimIn);
  } else {
    trimOut = Math.min(trimDuration, Math.max(t, trimIn + 0.1));
    seekTrimVideo(trimOut);
  }
  updateTimeline();
});

tlTrack.addEventListener("pointerup", () => {
  if (trimDragging) {
    tlHandleIn.classList.remove("dragging");
    tlHandleOut.classList.remove("dragging");
    tlPlayhead.classList.remove("dragging");
    trimDragging = null;
    updateTimelineLabels();
  }
});

tlTrack.addEventListener("pointercancel", () => {
  if (trimDragging) {
    tlHandleIn.classList.remove("dragging");
    tlHandleOut.classList.remove("dragging");
    tlPlayhead.classList.remove("dragging");
    trimDragging = null;
  }
});

function updateTimeline() {
  if (trimDuration <= 0) return;
  const inPct = ((trimIn / trimDuration) * 100).toFixed(3) + "%";
  const outPct = ((trimOut / trimDuration) * 100).toFixed(3) + "%";
  tlTrack.style.setProperty("--trim-in", inPct);
  tlTrack.style.setProperty("--trim-out", outPct);
  tlHandleIn.style.left = inPct;
  tlHandleOut.style.left = outPct;
  tlSelection.style.left = inPct;
  tlSelection.style.width =
    (((trimOut - trimIn) / trimDuration) * 100).toFixed(3) + "%";
  updateTimelineLabels();
}

function updateTimelineLabels() {
  document.getElementById("tlLabelIn").textContent = fmtTimeShort(trimIn);
  document.getElementById("tlLabelOut").textContent = fmtTimeShort(trimOut);
}

function renderTimeRuler() {
  const ruler = document.getElementById("tlRuler");
  ruler.innerHTML = "";
  if (trimDuration <= 0) return;

  const tickCount = Math.min(10, Math.max(2, Math.ceil(trimDuration / 10)));
  const step = trimDuration / tickCount;

  for (let index = 0; index <= tickCount; index++) {
    const time = index === tickCount ? trimDuration : index * step;
    const tick = document.createElement("span");
    tick.className = "tl-ruler-tick";
    tick.style.left = `${(time / trimDuration) * 100}%`;
    tick.innerHTML = `<b>${fmtTimeShort(time)}</b><i></i>`;
    ruler.appendChild(tick);
  }
}

// ── Audio tracks ──────────────────────────────────────────────────
// Note: Chromium does not implement HTMLMediaElement.audioTracks,
// so per-track preview isolation is not possible. Toggles here affect export only.

function renderAudioTracks() {
  const list = document.getElementById("trimTrackList");

  if (!trimAudioTracks || trimAudioTracks.length === 0) {
    list.style.display = "none";
    return;
  }
  list.style.display = "";
  list.innerHTML = "";
  renderTrackInfo();

  trimAudioTracks.forEach((track) => {
    const exportEnabled =
      trimEnabledTracks === null || trimEnabledTracks.has(track.index);

    const row = document.createElement("div");
    row.className = "trim-track" + (exportEnabled ? " on" : "");
    row.dataset.index = track.index;
    row.innerHTML = `
      <div class="trim-track-fill"></div>
      <span class="trim-track-wave" aria-hidden="true"></span>`;

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleAudioTrack(parseInt(row.dataset.index));
    });
    row.addEventListener("pointerdown", (e) => e.stopPropagation());

    list.appendChild(row);
  });
}

function toggleAudioTrack(index) {
  if (trimEnabledTracks === null) {
    trimEnabledTracks = new Set(
      trimAudioTracks
        .map((track) => track.index)
        .filter((trackIndex) => trackIndex !== index),
    );
  } else if (trimEnabledTracks.has(index)) {
    trimEnabledTracks.delete(index);
  } else {
    trimEnabledTracks.add(index);
    if (trimEnabledTracks.size === trimAudioTracks.length)
      trimEnabledTracks = null;
  }

  const enabled = trimEnabledTracks === null || trimEnabledTracks.has(index);
  document
    .querySelector(`.trim-track[data-index="${index}"]`)
    ?.classList.toggle("on", enabled);
  const checkbox = document.querySelector(
    `.tl-info-track-check[data-track-index="${index}"]`,
  );
  checkbox?.setAttribute("aria-checked", enabled);
  checkbox?.classList.toggle("on", enabled);
}

function renderTrackInfo() {
  const info = document.getElementById("tlTrackInfo");
  info.innerHTML = `<div class="tl-info-row tl-info-video">
    <span>Video</span>
    <div class="tl-labels">
      <span id="tlLabelIn">0:00</span>
      <span aria-hidden="true">→</span>
      <span id="tlLabelOut">–:––</span>
    </div>
  </div>`;

  trimAudioTracks.forEach((track) => {
    const exportEnabled =
      trimEnabledTracks === null || trimEnabledTracks.has(track.index);
    const row = document.createElement("div");
    row.className = "tl-info-row tl-info-audio";
    row.innerHTML = `
      <div class="tl-info-track-check ${exportEnabled ? "on" : ""}" role="checkbox" aria-checked="${exportEnabled}" data-track-index="${track.index}" tabindex="0">
        <svg width="8" height="6" viewBox="0 0 8 6" fill="none"><path d="M1 3l2 2 4-4" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <strong>Track ${track.index + 1}</strong>
      <button class="tl-info-volume-btn" type="button" aria-label="Adjust volume for track ${track.index + 1}" aria-haspopup="true">
        <span class="ui-icon" data-icon="track-icon" aria-hidden="true"></span>
      </button>
      <div class="tl-info-volume-popover">
        <span class="tl-info-volume-value">${Math.round((trimAudioVolumes[track.index] ?? 1) * 100)}%</span>
        <input class="tl-info-volume-slider" type="range" min="0" max="2" step="0.05" value="${trimAudioVolumes[track.index] ?? 1}" aria-label="Track ${track.index + 1} volume" />
      </div>`;
    const checkbox = row.querySelector(".tl-info-track-check");
    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleAudioTrack(track.index);
    });
    checkbox.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleAudioTrack(track.index);
      }
    });
    const volumePopover = row.querySelector(".tl-info-volume-popover");
    const volumeSlider = row.querySelector(".tl-info-volume-slider");
    volumeSlider.style.setProperty(
      "--volume-progress",
      `${Math.min(100, (parseFloat(volumeSlider.value) / 2) * 100)}%`,
    );
    volumeSlider.addEventListener("input", (event) => {
      const value = parseFloat(event.target.value);
      trimAudioVolumes[track.index] = value;
      volumeSlider.style.setProperty(
        "--volume-progress",
        `${Math.min(100, (value / 2) * 100)}%`,
      );
      volumePopover.querySelector(".tl-info-volume-value").textContent =
        `${Math.round(value * 100)}%`;
      if (trimAudioTracks.length === 1) {
        trimVideo.volume = value;
      } else {
        scheduleTrimPreviewRefresh();
      }
    });
    volumePopover.addEventListener("click", (event) => event.stopPropagation());
    info.appendChild(row);
  });
}

function scheduleTrimPreviewRefresh() {
  clearTimeout(trimPreviewRefreshTimer);
  trimPreviewRefreshTimer = setTimeout(refreshTrimPreview, 250);
}

async function refreshTrimPreview() {
  const item = queue.find((queueItem) => queueItem.id === trimItemId);
  if (!item || trimAudioTracks.length <= 1) return;
  const refreshItemId = trimItemId;

  const wasPlaying = !trimVideo.paused;
  const currentTime = trimVideo.currentTime;
  const oldPreview = trimPreviewTmp;
  const result = await invoke("get_mixed_preview_url", {
    filepath: item.path,
    audioVolumes: trimAudioVolumes,
  });
  if (trimItemId !== refreshItemId) {
    if (result.tmp) {
      invoke("delete_temp_file", { tmp_path: result.tmp }).catch(() => {});
    }
    return;
  }
  trimPreviewTmp = result.tmp;
  trimVideo.src = result.url ? convertFileSrc(result.url) : "";
  trimVideo.load();
  trimVideo.addEventListener(
    "loadedmetadata",
    () => {
      seekTrimVideo(currentTime);
      if (wasPlaying) trimVideo.play();
    },
    { once: true },
  );
  if (oldPreview) {
    invoke("delete_temp_file", { tmp_path: oldPreview }).catch(() => {});
  }
}

// ── Apply / close ─────────────────────────────────────────────────

function applyTrim() {
  const item = queue.find((i) => i.id === trimItemId);
  if (!item) {
    closeTrimModal();
    return;
  }

  const previousTrim = {
    trimStart: item.trimStart,
    trimEnd: item.trimEnd,
    enabledTracks: item.enabledTracks ? [...item.enabledTracks] : null,
    audioVolumes: item.audioVolumes ? [...item.audioVolumes] : [],
  };

  const inIsZero = trimIn <= 0.001;
  const outIsEnd = Math.abs(trimOut - trimDuration) <= 0.1;

  item.trimStart = inIsZero ? "" : fmtTimeFull(trimIn);
  item.trimEnd = outIsEnd ? "" : fmtTimeFull(trimOut);
  item.enabledTracks =
    trimEnabledTracks === null ? null : [...trimEnabledTracks];
  item.audioTracks = trimAudioTracks;
  item.audioVolumes = trimAudioVolumes;

  const trimChanged =
    previousTrim.trimStart !== item.trimStart ||
    previousTrim.trimEnd !== item.trimEnd ||
    JSON.stringify(previousTrim.enabledTracks) !==
      JSON.stringify(item.enabledTracks) ||
    JSON.stringify(previousTrim.audioVolumes) !==
      JSON.stringify(item.audioVolumes);
  if (trimChanged && ["done", "error", "cancelled"].includes(item.status)) {
    requeueItem(item.id);
  }

  const statusRow = document.getElementById(`${trimItemId}-status`);
  const badge = statusRow?.querySelector(".qi-trim-badge");
  const hasTrim = !inIsZero || !outIsEnd;
  const hasTrackFilter = trimEnabledTracks !== null;

  if (hasTrim || hasTrackFilter) {
    const badgeText = [
      hasTrim ? `${fmtTimeShort(trimIn)}–${fmtTimeShort(trimOut)}` : null,
      hasTrackFilter
        ? `${trimEnabledTracks.size}/${trimAudioTracks.length} tracks`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

    if (badge) {
      badge.textContent = badgeText;
    } else {
      const b = document.createElement("span");
      b.className = "qi-trim-badge";
      b.textContent = badgeText;
      statusRow?.appendChild(b);
    }
    document.getElementById(`${trimItemId}-trimbtn`)?.classList.add("active");
  } else {
    badge?.remove();
    document
      .getElementById(`${trimItemId}-trimbtn`)
      ?.classList.remove("active");
  }

  closeTrimModal();
}

function closeTrimModal() {
  clearTimeout(trimPreviewRefreshTimer);
  trimVideo.pause();
  trimVideo.src = "";
  document.getElementById("trimOverlay").classList.remove("open");
  if (trimPreviewTmp) {
    invoke("delete_temp_file", { tmp_path: trimPreviewTmp }).catch(() => {});
    trimPreviewTmp = null;
  }
  trimItemId = null;
  closeTrimItemMenu();
}

document.getElementById("trimOverlay").addEventListener("click", (e) => {
  if (e.target === document.getElementById("trimOverlay")) closeTrimModal();
  else if (!e.target.closest(".trim-modal-header")) closeTrimItemMenu();
});

document.addEventListener("keydown", (e) => {
  if (!document.getElementById("trimOverlay").classList.contains("open"))
    return;

  if (e.key === "Escape") {
    if (trimItemMenu?.classList.contains("open")) {
      closeTrimItemMenu();
      return;
    }
    closeTrimModal();
  } else if (e.key === " ") {
    e.preventDefault();
    toggleTrimPlay();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    skipVideo(-5);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    skipVideo(5);
  } else if (e.key === ",") {
    e.preventDefault();
    stepTrimFrame(-1);
  } else if (e.key === ".") {
    e.preventDefault();
    stepTrimFrame(1);
  }
});
