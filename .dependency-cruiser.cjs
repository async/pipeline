const noCircular = require("./node_modules/dependency-cruiser/configs/rules/no-circular.cjs");
const noNonPackageJson = require("./node_modules/dependency-cruiser/configs/rules/no-non-package-json.cjs");
const notToUnresolvable = require("./node_modules/dependency-cruiser/configs/rules/not-to-unresolvable.cjs");

module.exports = {
  forbidden: [
    noCircular,
    noNonPackageJson,
    notToUnresolvable,
    {
      name: "core-stays-runtime-agnostic",
      severity: "error",
      comment: "pipeline-core is the declaration/runtime model and must not import node adapters or the published wrapper.",
      from: { path: "^packages/pipeline-core/src" },
      to: { path: "^packages/(pipeline-node|pipeline-adapter-lima|pipeline)/" }
    },
    {
      name: "node-stays-below-adapters",
      severity: "error",
      comment: "pipeline-node may depend on core, but not on adapter packages or the published wrapper.",
      from: { path: "^packages/pipeline-node/src" },
      to: { path: "^packages/(pipeline-adapter-lima|pipeline)/" }
    },
    {
      name: "internals-do-not-import-published-wrapper",
      severity: "error",
      comment: "internal packages must not depend on the convenience @async/pipeline wrapper.",
      from: { path: "^packages/(pipeline-core|pipeline-node|pipeline-adapter-lima)/src" },
      to: { path: "^packages/pipeline/src" }
    }
  ],
  options: {
    doNotFollow: {
      path: "^(node_modules|packages/[^/]+/dist)"
    },
    combinedDependencies: true,
    exclude: {
      path: "(^|/)(\\.async|node_modules|dist|build)/"
    },
    preserveSymlinks: true,
    tsConfig: {
      fileName: "tsconfig.depcruise.json"
    }
  }
};
