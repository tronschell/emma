/* What the first launch asks the Mac for, and why. One table, shared by the walkthrough
   that shows it and by main's deep link, so the reason the user reads and the pane that
   opens can never drift. macOS has no API that grants any of these — only the user can,
   in System Settings — so every row is a sentence plus the pane it lives in. */

export const SETUP_PERMISSIONS = [
  {
    id: "accessibility",
    title: "Accessibility",
    what: "Watch for the Quick Ask gesture, and move the pointer when you ask Emma to.",
    why: "Double-tapping the left Option key is a key press in whatever app is in front, so macOS only reports it to an app you have trusted. The same grant is what lets Emma click and type for you — and that still asks before every run.",
    pane: "Privacy_Accessibility",
    note: "Emma has to be relaunched after you grant this before the gesture starts working.",
  },
  {
    id: "screen",
    title: "Screen Recording",
    what: "Take the picture of your screen you attach to a question.",
    why: "Nothing is captured until you ask for it — the ▣ orb, the ✎ pen, or a saved page. Each capture is compressed on this Mac and travels only with the turn you send it with.",
    pane: "Privacy_ScreenCapture",
    note: "",
  },
  {
    id: "files",
    title: "Files & Folders",
    what: "Keep your knowledge base as plain Markdown you can open in any app.",
    why: "Emma writes it into your Documents folder, so Finder, Spotlight, Obsidian, and your backups all see it. macOS asks the first time Emma writes there.",
    pane: "Privacy_FilesAndFolders",
    note: "",
  },
] as const;

export type SetupPermission = (typeof SETUP_PERMISSIONS)[number]["id"];

/* Grants Emma links to but does not ask for at first launch. The microphone belongs
   to dictation, which most people never switch on, so the walkthrough stays at three
   cards and Settings → Voice is what opens this pane. Speech Recognition is the same
   story one step further in: it is what the macOS recognizer is granted under, and
   only the "macOS · built in" engine ever asks for it. */
const EXTRA_PANES: Record<string, string> = { microphone: "Privacy_Microphone", speech: "Privacy_SpeechRecognition" };
export type LinkedPermission = SetupPermission | "microphone" | "speech";

/** Status of the three grants, plus where the knowledge base is going to live. */
export type SetupStatus = Record<SetupPermission, boolean> & { knowledgeDir: string };

/**
 * The System Settings pane for one grant. The pane name comes from the table above
 * rather than from the caller, so a renderer can never talk main into opening an
 * arbitrary `x-apple.systempreferences:` URL.
 */
export function privacySettingsUrl(id: unknown): string {
  const pane = SETUP_PERMISSIONS.find((item) => item.id === id)?.pane ?? (typeof id === "string" ? EXTRA_PANES[id] : undefined);
  if (!pane) throw new Error("That is not a permission Emma asks for.");
  return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
}
