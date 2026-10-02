// ════════════════════════════════════════
// PEAK — Video Compressor  |  preview.js
// ════════════════════════════════════════
// Thumbnail preview modal with Discord-like controls.

let previewItemId = null;
let previewItemPath = null;
let previewTmpPath = null;
let previewDuration = 0;

const previewOverlay = document.getElementById("previewOverlay");
const previewVideo = document.getElementById("previewVideo");
const previewTitle = document.getElementById("previewTitle");
const previewSeek = document.getElementById("previewSeek");
const previewVolume = document.getElementById("previewVolume");
const previewElapsedTime = document.getElementById("previewElapsedTime");
const previewDurationTime = document.getElementById("previewDurationTime");
const previewPlayIcon = document.getElementById("previewPlayIcon");
const previewVideoError = document.getElementById("previewVideoError");
const previewPlayerShell = document.getElementById("previewPlayerShell");
const previewFullscreenIcon = document.getElementById("previewFullscreenIcon");
const previewPrevBtn = document.getElementById("previewPrevBtn");
const previewNextBtn = document.getElementById("previewNextBtn");
const previewFsCloseBtn = document.getElementById("previewFsCloseBtn");
let previewFsCloseTimer = null;
let previewClosing = false;
let previewWindowFullscreen = false;

function _findPreviewItem(id) {
  return queue.find((i) => i.id === id) || null;
}

async function previewQueueItem(id) {
  const item = _findPreviewItem(id);
  if (!item) return;

  if (previewMode === "external") {
    try {
      await invoke("open_in_media_player", { filepath: item.path });
    } catch (_) {
      setStatus("Could not open default media player", "error");
    }
    return;
  }

  await openPreviewModal(item);
}

async function openPreviewModal(item) {
  await _openPreviewForItem(item, false);
}

async function _openPreviewForItem(item, autoplay) {
  if (!item) return;

  previewItemId = item.id;
  previewItemPath = item.path;
  previewDuration = 0;
  previewTitle.textContent = item.name;
  previewElapsedTime.textContent = "0:00";
  previewDurationTime.textContent = "0:00";
  previewSeek.value = 0;
  previewVideoError.classList.remove("show");
  _updatePreviewNavButtons();

  if (previewTmpPath) {
    invoke("delete_temp_file", { tmp_path: previewTmpPath }).catch(() => {});
    previewTmpPath = null;
  }

  previewOverlay.classList.add("open");

  try {
    const result = await invoke("get_mixed_preview_url", {
      filepath: item.path,
      audioVolumes: null,
    });
    previewTmpPath = result?.tmp || null;
    previewVideo.src = result?.url ? convertFileSrc(result.url) : "";
    previewVideo.load();
    if (autoplay) {
      previewVideo.play().catch(() => {});
    }
  } catch (_) {
    previewVideoError.classList.add("show");
    setStatus("Preview failed to load", "error");
  }
}

async function _exitPreviewFullscreenIfNeeded() {
  if (previewWindowFullscreen) {
    await _setPreviewWindowFullscreen(false);
  }
  if (document.fullscreenElement === previewPlayerShell) {
    try {
      await document.exitFullscreen?.();
    } catch (_) {
      // Ignore and continue cleanup; some environments can reject if already exiting.
    }
  }
}

async function _setPreviewWindowFullscreen(enabled) {
  try {
    const ok = await invoke("set_window_fullscreen", { enabled: !!enabled });
    if (!ok) return false;
    previewWindowFullscreen = !!enabled;
    _updateFullscreenIcon();
    return true;
  } catch (_) {
    return false;
  }
}

async function closePreviewModal() {
  if (previewClosing) return;
  previewClosing = true;

  _hidePreviewFsClose();
  await _exitPreviewFullscreenIfNeeded();

  previewVideo.pause();
  previewVideo.src = "";
  previewOverlay.classList.remove("open");
  previewVideoError.classList.remove("show");
  previewDuration = 0;

  if (previewTmpPath) {
    invoke("delete_temp_file", { tmp_path: previewTmpPath }).catch(() => {});
    previewTmpPath = null;
  }

  previewItemId = null;
  _updatePreviewNavButtons();
  previewClosing = false;
}

function togglePreviewPlay() {
  if (!previewVideo.src) return;
  if (previewVideo.paused) previewVideo.play();
  else previewVideo.pause();
}

function togglePreviewMute() {
  previewVideo.muted = !previewVideo.muted;
}

function openPreviewInExternal() {
  const item = _findPreviewItem(previewItemId);
  if (!item) return;
  invoke("open_in_media_player", { filepath: item.path }).catch(() => {});
}

async function openPreviewTrimModal() {
  if (!previewItemId || typeof openTrimModal !== "function") return;
  const targetId = previewItemId;
  await closePreviewModal();
  await openTrimModal(targetId);
}

function _setPreviewPlayIcon(playing) {
  previewPlayIcon.innerHTML = playing
    ? '<img src="../ui-icons/Pause.svg" alt="Pause"/>'
    : '<img src="../ui-icons/Play.svg" alt="Play"/>';
}

function _getPreviewQueueIndex() {
  if (!previewItemId) return -1;
  return queue.findIndex((i) => i.id === previewItemId);
}

function _updatePreviewNavButtons() {
  const idx = _getPreviewQueueIndex();
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < queue.length - 1;

  if (previewPrevBtn) previewPrevBtn.disabled = !hasPrev;
  if (previewNextBtn) previewNextBtn.disabled = !hasNext;
}

async function _navigatePreviewClip(step) {
  const idx = _getPreviewQueueIndex();
  if (idx < 0) return;
  const nextIdx = idx + step;
  if (nextIdx < 0 || nextIdx >= queue.length) return;

  const target = queue[nextIdx];
  if (!target) return;

  const keepPlaying = !previewVideo.paused;
  await _openPreviewForItem(target, keepPlaying);
}

function previewPrevClip() {
  _navigatePreviewClip(-1);
}

function previewNextClip() {
  _navigatePreviewClip(1);
}

function _updatePreviewTime() {
  const cur = isFinite(previewVideo.currentTime) ? previewVideo.currentTime : 0;
  const dur =
    isFinite(previewDuration) && previewDuration > 0 ? previewDuration : 0;
  previewElapsedTime.textContent = fmtTimeShort(cur);
  previewDurationTime.textContent = fmtTimeShort(dur);
  if (dur > 0) {
    previewSeek.value = ((cur / dur) * 100).toFixed(2);
  }
  _setPreviewSeekProgress();
}

function _setPreviewSeekProgress() {
  if (!previewSeek) return;
  const pct = Math.max(0, Math.min(100, parseFloat(previewSeek.value) || 0));
  previewSeek.style.setProperty("--seek-progress", `${pct}%`);
}

function _setPreviewVolumeProgress() {
  if (!previewVolume) return;
  const pct = Math.max(
    0,
    Math.min(100, parseFloat(previewVolume.value) * 100 || 0),
  );
  previewVolume.style.setProperty("--volume-progress", `${pct}%`);
}

function togglePreviewFullscreen() {
  _setPreviewWindowFullscreen(!previewWindowFullscreen);
}

function _updateFullscreenIcon() {
  const isFs =
    previewWindowFullscreen ||
    document.fullscreenElement === previewPlayerShell;
  previewOverlay?.classList.toggle("window-fullscreen", isFs);

  previewFullscreenIcon.innerHTML = isFs
    ? `<img src="../ui-icons/ExitFullscreen.svg" alt="Exit Fullscreen"/>`
    : `<img src="../ui-icons/Fullscreen.svg" alt="Fullscreen"/>`;

  if (!isFs) {
    _hidePreviewFsClose();
  } else {
    _showPreviewFsClose();
  }
}

function _hidePreviewFsClose() {
  if (previewFsCloseTimer) {
    clearTimeout(previewFsCloseTimer);
    previewFsCloseTimer = null;
  }
  previewFsCloseBtn?.classList.remove("visible");
}

function _showPreviewFsClose() {
  const isFullscreen =
    previewWindowFullscreen ||
    document.fullscreenElement === previewPlayerShell;
  if (!isFullscreen || !previewFsCloseBtn) return;
  previewFsCloseBtn.classList.add("visible");
  if (previewFsCloseTimer) clearTimeout(previewFsCloseTimer);
  previewFsCloseTimer = setTimeout(() => {
    previewFsCloseBtn.classList.remove("visible");
    previewFsCloseTimer = null;
  }, 1600);
}

previewVideo.addEventListener("loadedmetadata", () => {
  previewDuration =
    isFinite(previewVideo.duration) && previewVideo.duration > 0
      ? previewVideo.duration
      : 0;
  _updatePreviewTime();
  previewVideoError.classList.remove("show");
});

previewVideo.addEventListener("timeupdate", _updatePreviewTime);
previewVideo.addEventListener("play", () => _setPreviewPlayIcon(true));
previewVideo.addEventListener("pause", () => _setPreviewPlayIcon(false));
previewVideo.addEventListener("error", () => {
  previewVideoError.classList.add("show");
});

previewVideo.addEventListener("click", togglePreviewPlay);

previewSeek.addEventListener("input", () => {
  if (!(previewDuration > 0)) return;
  previewVideo.currentTime =
    (parseFloat(previewSeek.value) / 100) * previewDuration;
  _setPreviewSeekProgress();
});

previewVolume.addEventListener("input", () => {
  previewVideo.volume = parseFloat(previewVolume.value);
  previewVideo.muted = previewVideo.volume <= 0;
  _setPreviewVolumeProgress();
});

previewVideo.addEventListener("volumechange", () => {
  if (previewVideo.muted) {
    previewVolume.value = 0;
  } else if (previewVideo.volume > 0 && parseFloat(previewVolume.value) === 0) {
    previewVolume.value = previewVideo.volume.toFixed(2);
  }
  _setPreviewVolumeProgress();
});

previewOverlay.addEventListener("click", (e) => {
  if (e.target === previewOverlay) closePreviewModal();
});

previewPlayerShell.addEventListener("mousemove", _showPreviewFsClose);
previewPlayerShell.addEventListener("pointermove", _showPreviewFsClose);

document.addEventListener("keydown", (e) => {
  if (!previewOverlay.classList.contains("open")) return;
  if (e.key === "Escape") {
    closePreviewModal();
  } else if (e.key === " ") {
    e.preventDefault();
    togglePreviewPlay();
  } else if (e.key.toLowerCase() === "f") {
    e.preventDefault();
    togglePreviewFullscreen();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    previewPrevClip();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    previewNextClip();
  }
});

document.addEventListener("fullscreenchange", _updateFullscreenIcon);

_setPreviewSeekProgress();
