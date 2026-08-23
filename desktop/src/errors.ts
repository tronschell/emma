/// The sentence to put on screen for a failed call.
///
/// Electron wraps anything a main-process handler throws as
/// `Error invoking remote method 'emma:request': Error: <the real message>`, and that
/// prefix is the first thing a person reads. Every message the host and the agent write
/// is aimed at that person; the wrapper is aimed at whoever wrote the IPC channel.
export function reasonText(reason: unknown): string {
  const raw = (reason instanceof Error ? reason.message : String(reason)).trim();
  // Anchored on the wrapper's exact shape rather than on the first "Error: " anywhere
  // in the string, which would eat a real message that happens to contain one.
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "").trim() || "Something went wrong.";
}
