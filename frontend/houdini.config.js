/// <references types="houdini-svelte">

/** @type {import('houdini').ConfigFile} */
const config = {
  schemaPath: "../shared/schema.graphql",
  watchSchema: {
    url: "http://localhost:4000/graphql",
  },
  scalars: {
    DateTime: { type: "string" },
    JSON: { type: "Record<string, number | string | boolean>" },
  },
  plugins: {
    "houdini-svelte": {
      client: "./src/lib/houdini-client.ts",
      forceRunesMode: true,
    },
  },
};

export default config;
