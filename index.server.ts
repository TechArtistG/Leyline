import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadStyleRpc, rendererReportRpc } from "./shared/contracts";
import { loadStyle } from "./server/style";

export default function contribute(server: PluginServerContext) {
  server.handle(rendererReportRpc, ({ surface, ok, detail }) => {
    console.log(`[leyline] renderer ${ok ? "ok" : "FAILED"} (${surface}): ${detail}`);
    return { received: true as const };
  });
  server.handle(loadStyleRpc, (input, { paseo }) => loadStyle(input, paseo));
  return () => {};
}
