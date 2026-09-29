const statusSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    text: { type: "string" },
    active: { type: "boolean" },
    viewerUrl: { type: "string" },
  },
  required: ["text", "active"],
  additionalProperties: false,
} as const;

export const WEAVE_RPC = {
  id: "pi-weave",
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: statusSchema,
    },
  },
  events: {
    status: { schema: statusSchema },
    viewer: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          url: { type: "string" },
          open: { type: "boolean" },
          started: { type: "boolean" },
        },
        required: ["sessionID", "url", "open", "started"],
        additionalProperties: false,
      },
    },
  },
} as const;
