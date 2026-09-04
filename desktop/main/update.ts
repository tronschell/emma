import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, autoUpdater, dialog, powerMonitor } from "electron";
import { CHECK_TICK_MS, DEFAULT_UPDATE_ORIGIN, dueForCheck, newerVersion, savedUpdate, updateFeedUrl, updateOrigin } from "../shared/update";

const FAKE_ANNOUNCE_MS = 4000;

let ready = "";
let installable = false;
let lastCheck = 0;
let asked = false;
let announceReady: (version: string) => void = () => {};
let recheck: (() => void) | undefined;
let installWhenReady = false;

const readyFile = () => path.join(app.getPath("userData"), "update-ready.json");

function rememberReady(version: string) {
  try {
    writeFileSync(readyFile(), JSON.stringify({ version }));
  } catch (error) {
    console.error("Emma: could not record the downloaded update", error);
  }
}

function recallReady(): string {
  try {
    return savedUpdate(JSON.parse(readFileSync(readyFile(), "utf8")), app.getVersion());
  } catch {
    return "";
  }
}

function forgetReady() {
  try {
    rmSync(readyFile(), { force: true });
  } catch (error) {
    console.error("Emma: could not clear the recorded update", error);
  }
}

export function readyUpdate() {
  return ready;
}

export function installUpdate() {
  if (!ready) {
    console.warn("Emma: no update is downloaded");
    return;
  }
  if (!installable) {
    installWhenReady = true;
    forceCheck();
    return;
  }
  autoUpdater.quitAndInstall();
}

function forceCheck() {
  if (!recheck) {
    reportUpToDate();
    return;
  }
  asked = true;
  lastCheck = 0;
  recheck();
}

export function checkForUpdates() {
  if (ready && installable) {
    announceReady(ready);
    return;
  }
  forceCheck();
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
    installWhenReady = false;
    if (!asked) return;
    asked = false;
    reportFailure(error);
  });
  autoUpdater.on("update-not-available", () => {
    installWhenReady = false;
    if (!asked) return;
    asked = false;
    reportUpToDate();
  });
  autoUpdater.on("update-downloaded", (_event, _notes, name) => {
    asked = false;
    const install = installWhenReady;
    installWhenReady = false;
    const version = newerVersion(app.getVersion(), name);
    if (!version) return;
    ready = version;
    installable = true;
    rememberReady(version);
    announce(version);
    if (install) autoUpdater.quitAndInstall();
  });
  try {
    autoUpdater.setFeedURL({ url: updateFeedUrl(origin, process.platform, process.arch, app.getVersion()) });
  } catch (error) {
    console.error("Emma: update feed unavailable", error);
    return;
  }
  const restored = recallReady();
  if (restored) {
    ready = restored;
    announce(restored);
  } else {
    forgetReady();
  }
  const check = () => {
    if (!dueForCheck(Date.now(), lastCheck, installable)) return;
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
