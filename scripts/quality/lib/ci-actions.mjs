export const CI_ACTIONS = Object.freeze({
  checkout: Object.freeze({
    reference: "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
    version: "v5.1.0",
  }),
  setupJava: Object.freeze({
    reference: "actions/setup-java@03ad4de0992f5dab5e18fcb136590ce7c4a0ac95",
    version: "v5.6.0",
  }),
  setupNode: Object.freeze({
    reference: "actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444",
    version: "v5.0.0",
  }),
  uploadArtifact: Object.freeze({
    reference: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    version: "v7.0.1",
  }),
});
