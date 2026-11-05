import type { PluginServerContext } from "@getpaseo/plugin/server";
import { rendererReportRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.handle(rendererReportRpc, ({ surface, ok, detail }) => {
    console.log(`[leyline] renderer ${ok ? "ok" : "FAILED"} (${surface}): ${detail}`);
    return { received: true as const };
  });
  return () => {};
}
