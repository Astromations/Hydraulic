// ════════════════════════════════════════
// HYDRAULIC — Video Compressor  |  changelog-modal.js
// ════════════════════════════════════════
// Changelog modal: build, open, close.

const LATEST_RELEASE_URL =
  "https://api.github.com/repos/Astromations/Hydraulic/releases/latest";
let latestRelease = null;
let installedVersion = null;

function compareVersions(left, right) {
  const parse = (version) =>
    String(version)
      .replace(/^v/i, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const leftParts = parse(left);
  const rightParts = parse(right);

  for (let index = 0; index < 3; index++) {
    if ((leftParts[index] || 0) !== (rightParts[index] || 0)) {
      return (leftParts[index] || 0) - (rightParts[index] || 0);
    }
  }
  return 0;
}

function setUpdateStatus(statusText, className, title) {
  const button = document.getElementById("changelogGithubBtn");
  const label = button.querySelector("span");
  label.textContent = statusText;
  button.classList.toggle("update-available", className === "update-available");
  button.title = title;
}

async function checkForUpdates() {
  setUpdateStatus("Checking...", "", "Checking for updates");

  try {
    installedVersion = await invoke("get_app_version");
    document.getElementById("appVersion").textContent = `v${installedVersion}`;

    const response = await fetch(LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

    const release = await response.json();
    const latestVersion = release.tag_name || release.name;
    latestRelease = latestVersion
      ? {
          url:
            release.html_url ||
            "https://github.com/Astromations/Hydraulic/releases/latest",
          isNewer: compareVersions(latestVersion, installedVersion) > 0,
        }
      : null;

    setUpdateStatus(
      latestRelease?.isNewer ? "Update Avaiable" : "On Latest",
      latestRelease?.isNewer ? "update-available" : "",
      latestRelease?.isNewer ? "Open latest release" : "On latest release",
    );
  } catch (error) {
    console.error("Update check failed", error);
    latestRelease = null;
    setUpdateStatus("Update Check Failed", "", "Unable to check for updates");
  }
}

function openLatestRelease() {
  if (latestRelease?.isNewer) openExternalUrl(null, latestRelease.url);
}

function buildChangelog() {
  const body = document.getElementById("changelogBody");
  body.innerHTML = "";

  CHANGELOG.forEach((entry, idx) => {
    const block = document.createElement("div");
    block.className = "cl-version";

    const hdr = document.createElement("div");
    hdr.className = "cl-version-header";
    hdr.innerHTML =
      `<span class="cl-version-tag">${esc(entry.version)}</span>` +
      `<span class="cl-version-date">${esc(entry.date)}</span>` +
      (entry.latest ? `<span class="cl-version-latest">Latest</span>` : "");
    block.appendChild(hdr);

    const ul = document.createElement("ul");
    ul.className = "cl-changes";
    entry.changes.forEach((c) => {
      const li = document.createElement("li");
      li.textContent = c;
      ul.appendChild(li);
    });
    block.appendChild(ul);

    if (idx < CHANGELOG.length - 1) {
      const hr = document.createElement("hr");
      hr.className = "cl-divider";
      block.appendChild(hr);
    }

    body.appendChild(block);
  });
}

function openChangelog() {
  document.getElementById("changelogOverlay").classList.add("open");
}

function closeChangelog() {
  document.getElementById("changelogOverlay").classList.remove("open");
}

document.getElementById("changelogOverlay").addEventListener("click", (e) => {
  if (e.target === document.getElementById("changelogOverlay"))
    closeChangelog();
});

document.addEventListener("DOMContentLoaded", checkForUpdates);
