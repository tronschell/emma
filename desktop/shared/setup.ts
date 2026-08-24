import type { VaultChoice } from "./vault";

export const SETUP_PERMISSIONS = [
  {
    id: "accessibility",
    tasks: ["Control this Mac", "Quick Ask on ⌥⌥", "Bound shortcuts"],
    title: "Accessibility",
    what: "Opens Quick Ask on ⌥⌥, and moves the pointer when you ask.",
    why: "Double-tapping the left Option key is a key press in whatever app is in front, so macOS only reports it to an app you have trusted. The same grant is what lets Emma click and type for you — and that still asks before every run.",
    pane: "com.apple.preference.security?Privacy_Accessibility",
    relaunch: true,
  },
  {
    id: "screen",
    tasks: ["Screen captures", "Draw on the screen", "Vision"],
    title: "Screen Recording",
    what: "Attaches a picture of your screen to a question.",
    why: "Nothing is captured until you ask for it — the ▣ orb, the ✎ pen, or a saved page. Each capture is compressed on this Mac and travels only with the turn you send it with.",
    pane: "com.apple.preference.security?Privacy_ScreenCapture",
    relaunch: true,
  },
  {
    id: "microphone",
    tasks: ["Dictation", "Quick Ask with voice"],
    title: "Microphone",
    what: "Dictates into the composer instead of typing.",
    why: "Hold the ● orb, or the key you bind to voice, and Emma writes down what you say. The audio is transcribed and dropped; only the words reach a thread.",
    pane: "com.apple.preference.security?Privacy_Microphone",
    relaunch: false,
  },
  {
    id: "speech",
    tasks: ["Dictation · built-in engine"],
    title: "Speech Recognition",
    what: "Transcribes on this Mac with the built-in recognizer.",
    why: "Only the “macOS · built in” dictation engine asks for this, and only from a packaged Emma — under a development build macOS refuses the helper before it can ask. A local Whisper server needs neither.",
    pane: "com.apple.preference.security?Privacy_SpeechRecognition",
    relaunch: false,
  },
  {
    id: "automation",
    tasks: ["Save page", "Read the front tab"],
    title: "Automation",
    what: "Saves the page your browser has open, without a screenshot.",
    why: "Emma asks Safari or Chrome for the front tab's address and title, then fetches the page itself. macOS raises this the first time, once per browser, and lists Emma under the browser it is asking about.",
    pane: "com.apple.preference.security?Privacy_Automation",
    relaunch: false,
  },
  {
    id: "notifications",
    tasks: ["Turn finished", "Permission asks"],
    title: "Notifications",
    what: "Tells you when a turn finishes, or needs an answer.",
    why: "Emma posts one banner when a run lands or stops on a permission ask, and bounces the Dock icon when macOS will not. Nothing else is ever announced.",
    pane: "com.apple.preference.notifications",
    relaunch: false,
  },
  {
    id: "files",
    tasks: ["Your vault", "Connected folders"],
    title: "Files & Folders",
    what: "Writes what you keep into the vault or folder you chose.",
    why: "Each save is a plain Markdown note in a folder you already own — an Obsidian vault, iCloud Drive, anywhere. Nothing is kept in a format only Emma can open. macOS asks the first time Emma writes there.",
    pane: "com.apple.preference.security?Privacy_FilesAndFolders",
    relaunch: false,
  },
] as const;

export type SetupPermission = (typeof SETUP_PERMISSIONS)[number]["id"];

export type LinkedPermission = SetupPermission;

export type SetupStatus = Record<SetupPermission, boolean | null> & { vault: VaultChoice | null };

export function privacySettingsUrl(id: unknown): string {
  const pane = SETUP_PERMISSIONS.find((item) => item.id === id)?.pane;
  if (!pane) throw new Error("That is not a permission Emma asks for.");
  return `x-apple.systempreferences:${pane}`;
}
