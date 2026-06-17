import { greeting } from "./check.ts";

Deno.test("greeting identifies the Deno runtime path", () => {
  if (greeting("verify") !== "deno:verify") {
    throw new Error("unexpected greeting");
  }
});
