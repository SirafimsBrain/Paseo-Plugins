import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const consoleUrl = defineRpc({
  name: "remote-control.console-url",
  input: z.object({}),
  output: z.object({ url: z.string().nullable() }),
});

export const state = defineRpc({
  name: "remote-control.state",
  input: z.object({}),
  output: z.object({
    consoleUrl: z.string().nullable(),
    listening: z.boolean(),
    version: z.string(),
  }),
});
