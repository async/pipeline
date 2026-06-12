import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVersion, releaseSummary } from "./index.ts";

test("parseVersion splits major.minor.patch", () => {
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3 });
});

test("parseVersion rejects non-semver input", () => {
  assert.throws(() => parseVersion("not-a-version"), /Invalid version/);
});

test("releaseSummary labels 0.x as preview and 1.x as stable", () => {
  assert.equal(releaseSummary("pkg", "0.4.0").channel, "preview");
  assert.equal(releaseSummary("pkg", "1.0.0").channel, "stable");
});
