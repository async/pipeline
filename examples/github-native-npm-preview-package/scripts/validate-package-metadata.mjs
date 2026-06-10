import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const name = packageJson.name;
const packageNamePattern = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

if (!packageNamePattern.test(name ?? "")) {
  throw new Error(`Package name must be a lowercase scoped npm name. Found: ${name ?? "(missing)"}`);
}

if (!packageJson.repository) {
  throw new Error("package.json must include a repository field.");
}

if (packageJson.private !== true) {
  console.warn("This example is safest with private:true until you replace print-only publish tasks with real publish commands.");
}

console.log(`Package metadata looks publish-shaped for ${name}.`);
