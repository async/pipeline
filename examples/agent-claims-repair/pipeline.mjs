// ADR-0006 (claims triage) as a copyable example, and the canonical agent-step
// example from ADR-0001: a propose-only repair agent behind a mock profile.
// The agent emits a unified diff on stdout (landed as claims.patch via
// stdoutTo); a human reviews, applies, and the deterministic checker stays
// the only authority. ASYNC_AGENT=claude swaps in a real model locally.
import { agent, definePipeline, env, job, sh, task } from "@async/pipeline";

export default definePipeline({
  name: "agent-claims-repair",
  cache: "file:local",
  agents: {
    mock: { command: ["node", "scripts/mock-agent.mjs"], model: "mock" },
    claude: { command: ["claude", "-p"], model: "claude-sonnet-4-6" }
  },
  tasks: {
    claims: task({
      description: "The mini claims checker: every anchor in anchors.txt appears verbatim in docs/README.md.",
      inputs: ["anchors.txt", "docs/README.md", "scripts/check-claims.mjs"],
      cache: true,
      run: sh`node scripts/check-claims.mjs anchors.txt`
    }),
    "claims-repair": task({
      description: "Propose claims.patch for the committed stale fixture (anchors-stale.txt). Propose-only: nothing is edited.",
      inputs: ["anchors-stale.txt", "docs/README.md", "scripts/mock-agent.mjs"],
      outputs: ["claims.patch"],
      cache: true,
      run: agent({
        use: env.var("ASYNC_AGENT", { default: "mock" }),
        stdoutTo: "claims.patch",
        prompt: [
          "Registry file: anchors-stale.txt",
          "Docs file: docs/README.md",
          "Each registry line is `<id>\\t<anchor>`. Every anchor must appear verbatim in the docs file.",
          "Find each stale anchor, locate the reworded sentence in the docs, and output ONLY a unified diff",
          "against the registry file updating the anchors, applicable with `git apply`. No prose, no code fences.",
          "Never delete a registry line: dropped promises are a human decision."
        ].join("\n")
      })
    })
  },
  jobs: {
    verify: job({ target: "claims" }),
    repair: job({ target: "claims-repair" })
  }
});
