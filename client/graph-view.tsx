import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { loadStyleRpc, rendererReportRpc } from "../shared/contracts";
import { GRAPH_MODES, GRAPH_MODE_LABELS, type GraphHandle, type GraphMode } from "../shared/graph";
import { Graph } from "../shared/model/graph";
import { type GraphStyle, parseGraphStyle } from "../shared/model/style";
import { mockTopology } from "./mock/topology";
import { mountGraph } from "./web";

interface GraphViewProps {
  theme: PluginTheme;
  surface: "hub" | "workspace";
  caption: string;
  /** Workspace whose `.leyline/style.json` to load; omitted on the hub. */
  workspaceId?: string;
}

const MODES: ReadonlyArray<{ mode: GraphMode; label: string }> = GRAPH_MODES.map((mode) => ({
  mode,
  label: GRAPH_MODE_LABELS[mode],
}));

/** Hosts the WebGL graph. On native there is no renderer, so it shows a notice instead. */
export function GraphView({ theme, surface, caption, workspaceId }: GraphViewProps) {
  const parent = useRef<View>(null);
  const graph = useRef<GraphHandle | null>(null);
  const report = useRpc(rendererReportRpc);
  const loadStyle = useRpc(loadStyleRpc);
  const [mode, setModeState] = useState<GraphMode>("3d-hub");
  // The renderer mounts once per theme/surface; mode changes go through `setMode` without a remount,
  // so the mount effect reads the current mode from a ref rather than depending on it.
  const modeRef = useRef<GraphMode>(mode);
  const [info, setInfo] = useState<string>(Platform.OS === "web" ? "mounting…" : "WebGL renderer is web-only");
  const [styleError, setStyleError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      canvas: { flex: 1 },
      bar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      segment: {
        flexDirection: "row" as const,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 4,
        overflow: "hidden" as const,
      },
      button: { paddingHorizontal: 8, paddingVertical: 3, backgroundColor: theme.colors.surface2 },
      buttonActive: { backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.foreground, fontSize: 11 },
      buttonTextActive: { color: theme.colors.accentForeground, fontSize: 11 },
      action: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 4,
        backgroundColor: theme.colors.surface2,
      },
      caption: { color: theme.colors.foreground, fontSize: 12 },
      status: { flex: 1, textAlign: "right" as const, color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [theme],
  );

  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    // One model per mount; the renderer subscribes to it and also reads whatever is in it at mount.
    const model = new Graph();
    model.applyPatch(mockTopology());
    // Mount and style load run concurrently; whichever finishes second applies the style.
    let loadedStyle: GraphStyle | undefined;
    void (async () => {
      let detail: string;
      let ok = false;
      try {
        const handle = await mountGraph(parent.current, theme, modeRef.current, model, loadedStyle);
        if (cancelled) {
          handle?.destroy();
          return;
        }
        graph.current = handle;
        ok = handle !== null;
        detail = handle?.info ?? "mountGraph returned null";
        if (handle) {
          unsubscribe = handle.on((event) => {
            if (event.type === "select") setSelected(event.id);
          });
          if (loadedStyle) handle.setStyle(loadedStyle);
        }
      } catch (cause) {
        detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      }
      setInfo(detail);
      void report({ surface, ok, detail }).catch(() => undefined);
    })();
    void (async () => {
      let error: string | null = null;
      try {
        const result = await loadStyle({ workspaceId });
        if (cancelled) return;
        if (result.error) {
          error = `style: ${result.error}`;
        } else if (result.style !== null) {
          loadedStyle = parseGraphStyle(result.style);
          graph.current?.setStyle(loadedStyle);
        }
      } catch (cause) {
        error = `style: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
      if (!cancelled) setStyleError(error);
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
      graph.current?.destroy();
      graph.current = null;
      setSelected(null);
      setStyleError(null);
    };
  }, [loadStyle, report, surface, theme, workspaceId]);

  const setMode = useCallback((next: GraphMode) => {
    modeRef.current = next;
    setModeState(next);
    graph.current?.setMode(next);
  }, []);
  const relayout = useCallback(() => graph.current?.relayout(), []);
  const fit = useCallback(() => graph.current?.fit(), []);

  const status = [selected, styleError, info].filter((part): part is string => part !== null).join(" · ");

  return (
    <View style={styles.root}>
      <View ref={parent} style={styles.canvas} />
      <View style={styles.bar}>
        <Text style={styles.caption}>{caption}</Text>
        <View style={styles.segment} accessibilityRole="radiogroup" accessibilityLabel="Layout mode">
          {MODES.map(({ mode: m, label }) => {
            const active = m === mode;
            return (
              <Pressable
                key={m}
                accessibilityRole="button"
                accessibilityLabel={`${label} layout`}
                accessibilityState={{ selected: active }}
                onPress={() => setMode(m)}
                style={active ? [styles.button, styles.buttonActive] : styles.button}
              >
                <Text style={active ? styles.buttonTextActive : styles.buttonText}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Re-layout graph" onPress={relayout} style={styles.action}>
          <Text style={styles.buttonText}>Re-layout</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Fit graph to view" onPress={fit} style={styles.action}>
          <Text style={styles.buttonText}>Fit</Text>
        </Pressable>
        <Text style={styles.status} numberOfLines={1}>
          {status}
        </Text>
      </View>
    </View>
  );
}
