/* Presentation only. RomPatcherWeb owns source verification, Apply and downloads. */
(function () {
  "use strict";

  // For a new release, add its page and patch ZIP, list it first here, and update the root redirect and changelog.
  const versions = ["3.0.2", "3.0.1", "3.0.0", "3.0.b"];
  const versionRoute = version => "./" + version + (location.pathname.endsWith(".html") ? ".html" : "");
  const release = document.body.dataset.version;
  const returnLink = document.getElementById("dx-back");

  if (returnLink) {
    const from = new URLSearchParams(location.search).get("release");
    if (versions.includes(from)) {
      returnLink.href = versionRoute(from);
      returnLink.textContent = "Back to DX " + from;
    }
  }
  if (!versions.includes(release)) return;

  const versionForm = document.getElementById("dx-version-form");
  const versionSelect = document.getElementById("versionSelect");
  const options = versions.map(version => {
    let label = version;
    if (version === versions[0]) label += " (Latest)";
    else if (version === "3.0.b") label += " (Beta)";
    return new Option(label, version, version === release, version === release);
  });
  versionSelect.replaceChildren(...options);
  const openVersion = document.getElementById("dx-open-version");
  const updateOpenButton = () => { openVersion.disabled = versionSelect.value === release; };
  updateOpenButton();
  versionSelect.addEventListener("change", updateOpenButton);
  versionForm.addEventListener("submit", event => {
    event.preventDefault();
    if (versions.includes(versionSelect.value) && versionSelect.value !== release) {
      location.assign(versionRoute(versionSelect.value));
    }
  });

  const work = document.getElementById("dx-work");
  const title = document.getElementById("dx-state-title");
  const help = document.getElementById("dx-source-help");
  const name = document.getElementById("dx-source-name");
  const choose = document.getElementById("dx-choose-text");
  const steps = Array.from(document.querySelectorAll(".dx-steps li"));
  const progress = document.getElementById("dx-check-progress");
  const reload = document.getElementById("dx-reload");
  const requirements = document.getElementById("dx-requirements");
  // Keep only the last Apply milestone for this release in this tab. A reloaded
  // page still has to ask for the ISO again and verify its contents.
  const runKey = "dx-apply-progress-" + release;
  let previousRun = null;
  let savedPercent = null;
  try {
    previousRun = sessionStorage.getItem(runKey);
    sessionStorage.removeItem(runKey);
  } catch { /* A storage-restricted tab can still use the chooser. */ }
  requirements.open = !window.matchMedia("(max-width: 760px)").matches;
  reload.addEventListener("click", () => location.reload());
  document.addEventListener("dx-patcher-unavailable", () => {
    title.textContent = "Patcher couldn’t start";
    help.textContent = "Reload the release, or open it in a browser that supports web workers.";
    work.dataset.tone = "error";
    document.getElementById("rom-patcher-disc-status").textContent = "The patcher is unavailable in this browser session.";
    reload.hidden = false;
  });

  const states = {
    empty: [0, "Choose a disc image", "Use an unmodified USA ISO of Pokémon XD: Gale of Darkness."],
    checking: [0, "Checking your disc…", "The full disc is checked before Apply patch becomes available."],
    mismatch: [0, "Disc doesn’t match", "Choose your clean USA ISO. Renaming the file does not change its contents.", "error"],
    readError: [0, "Disc couldn’t be read", "Make sure the ISO is available on this device, then choose it again.", "error"],
    waitingPatch: [1, "Loading the DX patch…", "Your disc passed verification. Apply becomes available when the release patch is ready."],
    ready: [1, "Ready to apply", "DX " + release + " needs about 1.46 GB of temporary browser storage, plus space to save the ISO.", "good"],
    reading: [1, "Reading the verified disc…", "Keep this page open while your browser prepares the ISO for patching."],
    applying: [1, "Applying patch…", "Keep this tab open while your browser writes the ISO in sections."],
    applyError: [1, "Patch couldn’t be applied", "Your source disc is still verified.", "error"],
    patchError: [0, "Release patch unavailable", "Reload this release to fetch its bundled patch again.", "error"],
    saveError: [2, "Your ISO is ready to save", "Use Save patched ISO again to start the download.", "error"],
    requested: [2, "Download requested", "If the ISO is missing, choose Save patched ISO again. Once it finishes saving, you can clear the temporary copy.", "good"]
  };

  document.addEventListener("dx-disc-state", event => {
    const { state, fileName, progress: percent } = event.detail;
    const screen = states[state];
    if (!screen) return;
    const [step, heading, instruction, tone] = screen;
    work.dataset.state = state;
    work.dataset.step = String(step);
    work.dataset.tone = tone || "neutral";
    title.textContent = heading;
    help.textContent = instruction;
    if (state === "empty" && previousRun !== null && /^(?:100|[1-9]?\d)$/.test(previousRun)) {
      title.textContent = "Previous patch run was interrupted";
      help.textContent = "The last saved progress update was " + previousRun + "%. Choose your original USA ISO again to retry.";
    }
    previousRun = null;
    try {
      if (state === "applying" && Number.isInteger(percent)) {
        const milestone = Math.floor(percent / 5) * 5;
        if (milestone !== savedPercent) {
          sessionStorage.setItem(runKey, String(milestone));
          savedPercent = milestone;
        }
      } else if (savedPercent !== null && ["requested", "saveError", "applyError", "checking"].includes(state)) {
        sessionStorage.removeItem(runKey);
        savedPercent = null;
      }
    } catch { /* Progress reporting does not require session storage. */ }
    name.textContent = fileName || "No file selected";
    choose.textContent = fileName ? "Choose another ISO" : "Choose ISO";
    steps.forEach((item, index) => {
      item.classList.toggle("done", index < step);
      if (index === step) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
    progress.hidden = state !== "checking" && state !== "applying";
    progress.setAttribute("aria-label", state === "applying" ? "Patched ISO written" : "Disc verification");
    if (Number.isFinite(percent)) progress.value = percent;
    else progress.removeAttribute("value");
    reload.hidden = state !== "patchError";
  });
}());
