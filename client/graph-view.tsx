import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import { rendererReportRpc } from "../shared/contracts";
import { type SceneHandle, mountScene } from "./web";

interface GraphViewProps {
  theme: PluginTheme;
  surface: "hub" | "workspace";
  caption: string;
}

/** Hosts the WebGL canvas. On native there is no renderer, so it shows a notice instead. */
export function GraphView({ theme, surface, caption }: GraphViewProps) {
  const parent = useRef<View>(null);
  const scene = useRef<SceneHandle | null>(null);
  const report = useRpc(rendererReportRpc);
  const [status, setStatus] = useState<string>(Platform.OS === "web" ? "mounting…" : "WebGL renderer is web-only");

  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      canvas: { flex: 1 },
      bar: { paddingHorizontal: 12, paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.colors.border },
      caption: { color: theme.colors.foreground, fontSize: 12 },
      status: { color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [theme],
  );

  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    let cancelled = false;
    void (async () => {
      let detail: string;
      let ok = false;
      try {
        const handle = await mountScene(parent.current, theme);
        if (cancelled) {
          handle?.destroy();
          return;
        }
        scene.current = handle;
        ok = handle !== null;
        detail = handle?.info ?? "mountScene returned null";
      } catch (cause) {
        detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      }
      setStatus(detail);
      void report({ surface, ok, detail }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      scene.current?.destroy();
      scene.current = null;
    };
  }, [report, surface, theme]);

  return (
    <View style={styles.root}>
      <View ref={parent} style={styles.canvas} />
      <View style={styles.bar}>
        <Text style={styles.caption}>{caption}</Text>
        <Text style={styles.status}>{status}</Text>
      </View>
    </View>
  );
}
