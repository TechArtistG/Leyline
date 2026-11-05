import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Client → daemon: report what the renderer managed to initialise, so it shows in `paseo plugin logs`. */
export const rendererReportRpc = defineRpc({
  name: "leyline.renderer.report",
  input: z.object({
    surface: z.enum(["hub", "workspace"]),
    ok: z.boolean(),
    detail: z.string(),
  }),
  output: z.object({ received: z.literal(true) }),
});

/** Daemon reads `<workspace directory>/.leyline/style.json`; `style` is null when absent, `error` when invalid. */
export const loadStyleRpc = defineRpc({
  name: "leyline.style.load",
  input: z.object({ workspaceId: z.string().optional() }),
  output: z.object({
    path: z.string().nullable(),
    style: z.unknown().nullable(),
    error: z.string().nullable(),
  }),
});
