import { app, autoUpdater } from "electron";
import { DEFAULT_UPDATE_ORIGIN, newerVersion, updateFeedUrl, updateOrigin } from "../shared/update";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FAKE_ANNOUNCE_MS = 4000;

let ready = "";
let installable = false;

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

export function startUpdates(announce: (version: string) => void) {
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
  autoUpdater.on("error", (error) => console.error("Emma: update check failed", error));
  autoUpdater.on("update-downloaded", (_event, _notes, name) => {
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
    try {
      autoUpdater.checkForUpdates();
    } catch (error) {
      console.error("Emma: update check failed", error);
    }
  };
  check();
  setInterval(check, CHECK_INTERVAL_MS).unref();
}
