export function previewChannel(version) {
  return version.startsWith("0.0.0-pr.") ? "preview" : "stable";
}

