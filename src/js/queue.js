// ════════════════════════════════════════
// PEAK — Video Compressor  |  queue.js
// ════════════════════════════════════════
// Queue management, file browsing, and drag-drop.

// ── File browsing / drag-drop ─────────────────────────────────────
let queueViewMode = "list";
let dragSourceId = null;
let dragTargetId = null;
let dragPlaceBefore = false;

async function browseFiles() {
  if (isRunning) return;
  let paths;
  try {
    paths = await invoke("open_file_dialog");
  } catch (err) {
    setStatus("File dialog error: " + (err.message || err), "error");
    return;
  }
  // Normalise: some backends return null/undefined on cancel instead of []
  if (!Array.isArray(paths)) return;
  for (const p of paths) if (p) addToQueue(p);
}

const dz = document.getElementById("dropZone");
const videoExts = /\.(mp4|mkv|mov)$/i;

function handleDroppedPaths(paths) {
  if (isRunning || !Array.isArray(paths)) return;
  for (const p of paths) {
    if (typeof p === "string" && videoExts.test(p)) addToQueue(p);
  }
}

window.handleNativeDroppedPaths = (paths) => {
  handleDroppedPaths(paths || []);
};

function isExternalFileDrag(dataTransfer) {
  if (!dataTransfer?.types) return false;
  return Array.from(dataTransfer.types).includes("Files");
}

async function handleDroppedDataTransfer(dataTransfer) {
  if (isRunning || !dataTransfer) return;

  const files = Array.from(dataTransfer.files || []);

  // If browser dataTransfer is empty, Tauri drop listeners handle file paths.
  if (files.length === 0) return;

  for (const f of files) {
    let fullPath = f.path && f.path !== f.name ? f.path : null;

    if (!fullPath) {
      try {
        fullPath = await invoke("resolve_dropped_path", { filename: f.name });
      } catch (_) {
        fullPath = null;
      }
    }

    if (fullPath && videoExts.test(fullPath)) addToQueue(fullPath);
  }
}

dz.addEventListener("dragover", (e) => {
  e.preventDefault();
  dz.classList.add("hover");
});
dz.addEventListener("dragleave", () => dz.classList.remove("hover"));

dz.addEventListener("drop", async (e) => {
  e.preventDefault();
  dz.classList.remove("hover");
  await handleDroppedDataTransfer(e.dataTransfer);
});

// ── Queue management ──────────────────────────────────────────────
function addToQueue(path) {
  const normalizedPath = path.toLowerCase();
  if (queue.some((item) => item.path.toLowerCase() === normalizedPath)) return;

  const id = `qi-${++idCounter}`;
  const name = path.split(/[/\\]/).pop();
  queue.push({
    id,
    path,
    name,
    status: "waiting",
    trimStart: "",
    trimEnd: "",
    enabledTracks: null,
    audioTracks: [],
    audioVolumes: [],
  });
  renderQueueItem(id, name, path);
  setQueueDragEnabled(!isRunning);
  updateCompressBtn();

  invoke("get_thumbnail", { filepath: path }).then((uri) => {
    const t = document.querySelector(`#${id} .qi-thumb`);
    if (t)
      t.innerHTML = uri ? `<img src="${uri}" alt="" />` : thumbPlaceholder();
  });
}

function removeFromQueue(id) {
  queue = queue.filter((i) => i.id !== id);
  document.getElementById(id)?.remove();
  updateQueueEmpty();
  updateCompressBtn();
}

function updateQueueEmpty() {
  document.getElementById("queueEmpty").style.display =
    queue.length === 0 ? "flex" : "none";
}

function updateCompressBtn() {
  const waiting = queue.filter((i) => i.status === "waiting").length;
  const btn = document.getElementById("compressBtn");
  const label = document.getElementById("compressBtnLabel");
  const cancelBtn = document.getElementById("cancelBtn");
  const resumeBtn = document.getElementById("resumeBtn");
  setQueueDragEnabled(!isRunning);
  updateQueueEmpty();
  if (isRunning) {
    btn.disabled = true;
    label.textContent = cancelRequested ? "Cancelling..." : "Compressing...";
    if (cancelBtn) {
      cancelBtn.classList.add("visible");
      cancelBtn.disabled = !!cancelRequested;
      cancelBtn.textContent = cancelRequested
        ? "Cancelling..."
        : "Cancel Session";
    }
    if (resumeBtn) {
      resumeBtn.classList.remove("visible");
      resumeBtn.disabled = true;
      resumeBtn.textContent = "Resume Waiting Files";
    }
    return;
  }

  if (cancelBtn) {
    cancelBtn.classList.remove("visible");
    cancelBtn.disabled = false;
    cancelBtn.textContent = "Cancel Session";
  }

  if (resumeBtn) {
    const cancelled = queue.filter((i) => i.status === "cancelled").length;
    const showResume = sessionPaused && cancelled > 0;
    console.log(
      "[updateCompressBtn] sessionPaused=",
      sessionPaused,
      "cancelled=",
      cancelled,
      "showResume=",
      showResume,
    );
    resumeBtn.classList.toggle("visible", showResume);
    resumeBtn.disabled = !showResume;
    resumeBtn.textContent =
      cancelled === 1
        ? "Restart 1 Cancelled File"
        : `Restart ${cancelled} Cancelled Files`;
  }

  btn.disabled = waiting === 0;
  label.textContent =
    waiting === 1
      ? "Compress 1 file"
      : waiting > 1
        ? `Compress ${waiting} files`
        : "Compress";
}

function renderQueueItem(id, name, path) {
  const wrap = document.getElementById("queueWrap");
  const empty = document.getElementById("queueEmpty");
  const el = document.createElement("div");
  el.className = "qi";
  el.id = id;
  el.innerHTML = `
    <div class="qi-main">
      <div class="qi-drag-handle" role="button" tabindex="0" aria-label="Drag to reorder">
        <span class="ui-icon" data-icon="drag" aria-hidden="true"></span>
      </div>
      <button class="qi-thumb-hit" onclick="previewQueueItem('${id}')">
        <div class="qi-thumb"><div class="thumb-spinner"></div></div>
        <span class="qi-thumb-play" aria-hidden="true">
<span class="ui-icon" data-icon="play" aria-label="Play"></span></span
</span>
      </button>
      <div class="qi-body">
        <button class="qi-name qi-name-link" title="Reveal in explorer">${esc(name)}</button>
        <div class="qi-status-row" id="${id}-status">
          <span class="chip chip-waiting">Waiting</span>
        </div>
      </div>
      <div class="qi-actions">
        <button class="qi-btn rename" id="${id}-renamebtn" onclick="renameFile('${id}')" title="Rename output file" disabled>
          <span class="ui-icon" data-icon="rename" aria-label="Rename"></span>
        </button>
        <button class="qi-btn requeue" id="${id}-requeuebtn" onclick="requeueItem('${id}')" title="Requeue" aria-label="Re-export">
          <span class="ui-icon" data-icon="requeue" aria-hidden="true"></span>
        </button>
        <button class="qi-btn remove" onclick="removeFromQueue('${id}')" title="Remove"><span class="ui-icon" data-icon="remove" aria-label="Remove"></span></button>
        <button class="qi-btn trim-btn" id="${id}-trimbtn" onclick="openTrimModal('${id}')" title="Trim"><span class="ui-icon" data-icon="trim" aria-label="Trim"></span></button>
      </div>
    </div>`;

  const handle = el.querySelector(".qi-drag-handle");
  const nameButton = el.querySelector(".qi-name-link");
  nameButton?.addEventListener("click", () => revealSourceFile(path));

  const startDrag = (e) => {
    if (isRunning) {
      e.preventDefault();
      return;
    }
    dragSourceId = id;
    el.classList.add("dragging");
  };

  const endDrag = () => {
    el.classList.remove("dragging");
    wrap.querySelectorAll(".qi.drag-target").forEach((n) => {
      n.classList.remove(
        "drag-target",
        "drag-target-before",
        "drag-target-after",
      );
    });
    dragSourceId = null;
    dragTargetId = null;
    syncQueueOrderFromDom();
  };

  handle?.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || isRunning) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    startDrag(e);
  });

  handle?.addEventListener("pointermove", (e) => {
    if (dragSourceId !== id || !handle.hasPointerCapture(e.pointerId)) return;

    const hovered = getHoveredQueueItem(e.clientX, e.clientY, wrap);
    clearDragTargets(wrap);
    if (!hovered) {
      dragTargetId = null;
      return;
    }

    const rect = hovered.getBoundingClientRect();
    let placeBefore = e.clientY < rect.top + rect.height / 2;
    if (queueViewMode === "grid") {
      const horizontalOffset =
        Math.abs(e.clientX - (rect.left + rect.width / 2)) / rect.width;
      const verticalOffset =
        Math.abs(e.clientY - (rect.top + rect.height / 2)) / rect.height;
      placeBefore =
        horizontalOffset > verticalOffset
          ? e.clientX < rect.left + rect.width / 2
          : e.clientY < rect.top + rect.height / 2;
    }

    dragTargetId = hovered.id;
    dragPlaceBefore = placeBefore;
    hovered.classList.add(
      "drag-target",
      placeBefore ? "drag-target-before" : "drag-target-after",
    );
  });

  handle?.addEventListener("pointerup", (e) => {
    if (dragSourceId !== id) return;
    const source = document.getElementById(dragSourceId);
    const target = document.getElementById(dragTargetId);
    if (source && target && source !== target) {
      queueWrap.insertBefore(
        source,
        dragPlaceBefore ? target : target.nextSibling,
      );
    }
    handle.releasePointerCapture(e.pointerId);
    endDrag();
  });

  handle?.addEventListener("pointercancel", endDrag);

  wrap.insertBefore(el, empty);
  empty.style.display = "none";
}

function setQueueDragEnabled(enabled) {
  const wrap = document.getElementById("queueWrap");
  if (!wrap) return;
  wrap.classList.toggle("queue-locked", !enabled);
  wrap.querySelectorAll(".qi").forEach((item) => {
    const handle = item.querySelector(".qi-drag-handle");
    if (handle) handle.setAttribute("aria-disabled", String(!enabled));
  });
}

function setQueueView(mode) {
  const wrap = document.getElementById("queueWrap");
  if (!wrap || (mode !== "list" && mode !== "grid")) return;
  queueViewMode = mode;
  wrap.classList.toggle("queue-grid", mode === "grid");

  const listBtn = document.getElementById("queueViewListBtn");
  const gridBtn = document.getElementById("queueViewGridBtn");
  if (listBtn) listBtn.classList.toggle("active", mode === "list");
  if (gridBtn) gridBtn.classList.toggle("active", mode === "grid");

  setQueueDragEnabled(!isRunning);
}

function syncQueueOrderFromDom() {
  const wrap = document.getElementById("queueWrap");
  if (!wrap || queue.length <= 1) return;
  const ids = Array.from(wrap.querySelectorAll(".qi")).map((node) => node.id);
  if (!ids.length) return;
  const orderIndex = new Map(ids.map((id, idx) => [id, idx]));
  queue.sort((a, b) => {
    const ai = orderIndex.get(a.id);
    const bi = orderIndex.get(b.id);
    if (ai === undefined && bi === undefined) return 0;
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return ai - bi;
  });
}

function getHoveredQueueItem(x, y, wrap) {
  const hovered = document.elementFromPoint(x, y)?.closest(".qi");
  if (hovered && hovered.parentElement === wrap && hovered.id !== dragSourceId)
    return hovered;
  return null;
}

function clearDragTargets(wrap) {
  wrap.querySelectorAll(".qi.drag-target").forEach((n) => {
    n.classList.remove(
      "drag-target",
      "drag-target-before",
      "drag-target-after",
    );
  });
}

const queueWrap = document.getElementById("queueWrap");
queueWrap.addEventListener("dragover", (e) => {
  if (isRunning) return;

  if (isExternalFileDrag(e.dataTransfer)) {
    e.preventDefault();
    dz.classList.add("hover");
  }
});

queueWrap.addEventListener("drop", (e) => {
  if (isRunning) return;

  if (isExternalFileDrag(e.dataTransfer)) {
    e.preventDefault();
    dz.classList.remove("hover");
    void handleDroppedDataTransfer(e.dataTransfer);
  }
});

queueWrap.addEventListener("dragleave", () => {
  if (!dragSourceId) dz.classList.remove("hover");
});

setQueueView("list");
