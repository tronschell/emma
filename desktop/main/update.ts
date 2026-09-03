import { app, autoUpdater, dialog, powerMonitor } from "electron";
import { CHECK_TICK_MS, DEFAULT_UPDATE_ORIGIN, dueForCheck, newerVersion, updateFeedUrl, updateOrigin } from "../shared/update";

const FAKE_ANNOUNCE_MS = 4000;

let ready = "";
let installable = false;
let lastCheck = 0;
let asked = false;
let announceReady: (version: string) => void = () => {};
let recheck: (() => void) | undefined;

export function readyUpdate() {
  return ready;
}

export function installUpdate() {
  if (!ready || !installable) {
    console.warn("Emma: no installable update is downloaded");
    return;
  }
  autoUpdater.quitAndInstall();
}

export function checkForUpdates() {
  if (ready) {
    announceReady(ready);
    return;
  }
  if (!recheck) {
    reportUpToDate();
    return;
  }
  asked = true;
  lastCheck = 0;
  recheck();
}

function reportUpToDate() {
  void dialog.showMessageBox({ type: "info", message: "Emma is up to date.", detail: `You are running version ${app.getVersion()}.`, buttons: ["OK"] });
}

function reportFailure(error: unknown) {
  void dialog.showMessageBox({ type: "warning", message: "Emma could not check for updates.", detail: error instanceof Error ? error.message : String(error), buttons: ["OK"] });
}

export function startUpdates(announce: (version: string) => void) {
  announceReady = announce;
  if (!app.isPackaged) {
    const fake = newerVersion(app.getVersion(), process.env.EMMA_UPDATE_FAKE);
    if (!fake) return;
    setTimeout(() => { ready = fake; announce(fake); }, FAKE_ANNOUNCE_MS).unref();
    return;
  }
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  const origin = process.env.EMMA_UPDATE_URL ? updateOrigin(process.env.EMMA_UPDATE_URL) : DEFAULT_UPDATE_ORIGIN;
  if (!origin) {
    console.error("Emma: EMMA_UPDATE_URL is not an https origin; update checks are off");
    return;
  }
  autoUpdater.on("error", (error) => {
    console.error("Emma: update check failed", error);
    if (!asked) return;
    asked = false;
    reportFailure(error);
  });
  autoUpdater.on("update-not-available", () => {
    if (!asked) return;
    asked = false;
    reportUpToDate();
  });
  autoUpdater.on("update-downloaded", (_event, _notes, name) => {
    asked = false;
    const version = newerVersion(app.getVersion(), name);
    if (!version) return;
    ready = version;
    installable = true;
    announce(version);
  });
  try {
    autoUpdater.setFeedURL({ url: updateFeedUrl(origin, process.platform, process.arch, app.getVersion()) });
  } catch (error) {
    console.error("Emma: update feed unavailable", error);
    return;
  }
  const check = () => {
    if (!dueForCheck(Date.now(), lastCheck, ready)) return;
    lastCheck = Date.now();
    try {
      autoUpdater.checkForUpdates();
    } catch (error) {
      console.error("Emma: update check failed", error);
    }
  };
  recheck = check;
  check();
  setInterval(check, CHECK_TICK_MS).unref();
  powerMonitor.on("resume", check);
  app.on("browser-window-focus", check);
}
