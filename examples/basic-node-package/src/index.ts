export interface ReleaseSummary {
  name: string;
  version: string;
  channel: "stable" | "preview";
}

export function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    throw new Error(`Invalid version "${version}". Expected major.minor.patch.`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

export function releaseSummary(name: string, version: string): ReleaseSummary {
  const { major } = parseVersion(version);
  return {
    name,
    version,
    channel: major >= 1 ? "stable" : "preview"
  };
}
