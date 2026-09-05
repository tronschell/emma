export function localDevice(platform: string): string {
  return platform === "win32" ? "PC" : "Mac";
}

export function overlayLabel(platform: string): string {
  return platform === "win32" ? "Quick Ask" : "the island";
}
