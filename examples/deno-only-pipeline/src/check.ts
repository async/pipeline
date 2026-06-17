export function greeting(name = "pipeline"): string {
  return `deno:${name}`;
}

if (import.meta.main) {
  console.log(greeting());
}
