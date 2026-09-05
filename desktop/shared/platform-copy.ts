export function localDevice(platform: string): string {
  return platform === "win32" ? "PC" : "Mac";
}

export function overlayLabel(platform: string): string {
  return platform === "win32" ? "Quick Ask" : "the island";
}

export function unreadableKeyNotice(label: string, platform: string): string {
  const named = /key$/i.test(label) ? label : `${label} key`;
  return `Your saved ${named} could not be read on this ${localDevice(platform)}. Paste it again.`;
}
