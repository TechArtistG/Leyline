import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginHostProps, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { listBranchesRpc, loadStyleRpc, rendererReportRpc } from "../shared/contracts";
import { GRAPH_MODES, GRAPH_MODE_LABELS, type GraphHandle, type GraphMode } from "../shared/graph";
import { Graph } from "../shared/model/graph";
import { DEFAULT_STYLE, type GraphStyle, parseGraphStyle } from "../shared/model/style";
import { LEYLINE_SETTINGS_DEFAULTS, leylineSettings } from "../shared/settings";
import { mockTopology } from "./mock/topology";
import { LeylineSettingsForm } from "./settings/form";
import { mergeStyles, settingsStyleOverlay } from "./settings/overlay";
import { type TopologyHandle, startTopology } from "./topology/builder";
import { mountGraph } from "./web";

interface GraphViewProps {
  theme: PluginTheme;
  layout: PluginHostProps["layout"];
  surface: "hub" | "workspace";
  caption: string;
  /** Paseo host this surface is rendered for; becomes the `host:<id>` node. */
  hostId: string;
  hostLabel: string;
  /** Workspace whose `.leyline/style.json` to load and whose project scopes the graph; omitted on the hub. */
  workspaceId?: string;
}

type Source = "live" | "mock";

const MODES: ReadonlyArray<{ mode: GraphMode; label: string }> = GRAPH_MODES.map((mode) => ({
  mode,
  label: GRAPH_MODE_LABELS[mode],
}));

const SOURCES: ReadonlyArray<{ source: Source; label: string }> = [
  { source: "live", label: "Live" },
  { source: "mock", label: "Mock" },
];

/** Hosts the WebGL graph. On native there is no renderer, so it shows a notice instead. */
export function GraphView({ theme, layout, surface, caption, hostId, hostLabel, workspaceId }: GraphViewProps) {
  const parent = useRef<View>(null);
  const graph = useRef<GraphHandle | null>(null);
  const topology = useRef<TopologyHandle | null>(null);
  // One model per component; the renderer remounts on theme change and re-reads it, the topology does not restart.
  const [model] = useState(() => new Graph());
  const paseo = usePaseo();
  const report = useRpc(rendererReportRpc);
  const loadStyle = useRpc(loadStyleRpc);
  const listBranches = useRpc(listBranchesRpc);
  const settings = useSettings(leylineSettings);
  const settingsValues = settings.status === "ready" ? settings.values : null;
  // Until the store answers, the topology waits; if it answers with an error, the defaults apply.
  const settingsResolved = settings.status !== "loading";
  const [mode, setModeState] = useState<GraphMode>(LEYLINE_SETTINGS_DEFAULTS.defaultMode);
  const [source, setSource] = useState<Source>("live");
  // The renderer mounts once per theme/surface; mode changes go through `setMode` without a remount,
  // so the mount effect reads the current mode from a ref rather than depending on it.
  const modeRef = useRef<GraphMode>(mode);
  // The stored default mode applies once per panel, and never after the user picks a mode here.
  const modeChosen = useRef(false);
  const [info, setInfo] = useState<string>(Platform.OS === "web" ? "mounting…" : "WebGL renderer is web-only");
  const [projectStyle, setProjectStyle] = useState<GraphStyle | null>(null);
  const [styleError, setStyleError] = useState<string | null>(null);
  const [topologyError, setTopologyError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      stage: { flex: 1 },
      canvas: { flex: 1 },
      overlay: {
        position: "absolute" as const,
        right: 8,
        bottom: 8,
        alignItems: "flex-end" as const,
        gap: 6,
      },
      modeStack: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        overflow: "hidden" as const,
        backgroundColor: theme.colors.surface1,
      },
      modeButton: { width: 64, paddingVertical: 6, alignItems: "center" as const, backgroundColor: theme.colors.surface1 },
      modeButtonActive: { backgroundColor: theme.colors.accent },
      cog: {
        width: 32,
        height: 32,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        backgroundColor: theme.colors.surface1,
      },
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

  const setMode = useCallback((next: GraphMode) => {
    modeRef.current = next;
    setModeState(next);
    graph.current?.setMode(next);
  }, []);
  const chooseMode = useCallback(
    (next: GraphMode) => {
      modeChosen.current = true;
      setMode(next);
    },
    [setMode],
  );

  // Stored default mode: applied the first time settings arrive, unless the user already picked one.
  const defaultMode = settingsValues?.defaultMode;
  const defaultApplied = useRef(false);
  useEffect(() => {
    if (defaultMode === undefined || defaultApplied.current) return;
    defaultApplied.current = true;
    if (!modeChosen.current) setMode(defaultMode);
  }, [defaultMode, setMode]);

  // Built-in look, then the project's `.leyline/style.json`, then the user's display settings.
  const effectiveStyle = useMemo(
    () => mergeStyles(DEFAULT_STYLE, projectStyle ?? {}, settingsValues ? settingsStyleOverlay(settingsValues) : {}),
    [projectStyle, settingsValues],
  );
  const styleRef = useRef(effectiveStyle);
  useEffect(() => {
    styleRef.current = effectiveStyle;
    graph.current?.setStyle(effectiveStyle);
  }, [effectiveStyle]);

  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      let detail: string;
      let ok = false;
      try {
        const mountedStyle = styleRef.current;
        const handle = await mountGraph(parent.current, theme, modeRef.current, model, mountedStyle);
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
          // The style may have changed while the renderer's modules were loading.
          if (styleRef.current !== mountedStyle) handle.setStyle(styleRef.current);
        }
      } catch (cause) {
        detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      }
      setInfo(detail);
      void report({ surface, ok, detail }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
      graph.current?.destroy();
      graph.current = null;
      setSelected(null);
    };
  }, [model, report, surface, theme]);

  // Project style: the workspace's `.leyline/style.json`; the hub has none.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    let cancelled = false;
    void (async () => {
      let error: string | null = null;
      try {
        const result = await loadStyle({ workspaceId });
        if (cancelled) return;
        if (result.error) {
          error = `style: ${result.error}`;
        } else if (result.style !== null) {
          setProjectStyle(parseGraphStyle(result.style));
        }
      } catch (cause) {
        error = `style: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
      if (!cancelled) setStyleError(error);
    })();
    return () => {
      cancelled = true;
      setProjectStyle(null);
      setStyleError(null);
    };
  }, [loadStyle, workspaceId]);

  // Topology options follow the settings live; the builder is told via `setOptions`, never restarted.
  const topologyValues = settingsValues ?? LEYLINE_SETTINGS_DEFAULTS;
  const { showGitOnlyWorktrees, showOtherBranches, collapseHosts, gitRefreshSeconds } = topologyValues;
  const topologyOptions = useMemo(
    () => ({ showGitOnlyWorktrees, showOtherBranches, collapseHosts, gitRefreshSeconds }),
    [showGitOnlyWorktrees, showOtherBranches, collapseHosts, gitRefreshSeconds],
  );
  const topologyOptionsRef = useRef(topologyOptions);
  useEffect(() => {
    topologyOptionsRef.current = topologyOptions;
    topology.current?.setOptions(topologyOptions);
  }, [topologyOptions]);

  // Data source: the live Paseo topology or the fixture. Switching empties the model first so the
  // renderer never shows a blend; the live builder is stopped (every subscription released) on cleanup.
  useEffect(() => {
    if (Platform.OS !== "web" || !settingsResolved) return;
    model.applyPatch({ removeNodes: [...model.nodes.keys()] });
    setSelected(null);
    setTopologyError(null);
    if (source === "mock") {
      model.applyPatch(mockTopology());
      return;
    }
    const handle = startTopology({
      paseo,
      hostId,
      hostLabel,
      graph: model,
      listBranches,
      scope: workspaceId ? { workspaceId } : undefined,
      onError: setTopologyError,
      options: topologyOptionsRef.current,
    });
    topology.current = handle;
    return () => {
      handle.stop();
      if (topology.current === handle) topology.current = null;
    };
  }, [hostId, hostLabel, listBranches, model, paseo, settingsResolved, source, workspaceId]);

  const relayout = useCallback(() => graph.current?.relayout(), []);
  const fit = useCallback(() => graph.current?.fit(), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);

  const status = [selected, topologyError, styleError, info]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <View style={styles.root}>
      <View style={styles.stage}>
        <View ref={parent} style={styles.canvas} />
        <View style={styles.overlay}>
          <View style={styles.modeStack} accessibilityRole="radiogroup" accessibilityLabel="Layout mode">
            {MODES.map(({ mode: m, label }) => {
              const active = m === mode;
              return (
                <Pressable
                  key={m}
                  accessibilityRole="button"
                  accessibilityLabel={`${label} layout`}
                  accessibilityState={{ selected: active }}
                  onPress={() => chooseMode(m)}
                  style={active ? [styles.modeButton, styles.modeButtonActive] : styles.modeButton}
                >
                  <Text style={active ? styles.buttonTextActive : styles.buttonText}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Leyline settings"
            onPress={openSettings}
            style={styles.cog}
          >
            <Icon name="Settings" size={16} color={theme.colors.foreground} />
          </Pressable>
        </View>
      </View>
      <View style={styles.bar}>
        <Text style={styles.caption}>{caption}</Text>
        <View style={styles.segment} accessibilityRole="radiogroup" accessibilityLabel="Data source">
          {SOURCES.map(({ source: s, label }) => {
            const active = s === source;
            return (
              <Pressable
                key={s}
                accessibilityRole="button"
                accessibilityLabel={`${label} data`}
                accessibilityState={{ selected: active }}
                onPress={() => setSource(s)}
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
      <Modal title="Leyline settings" icon={<Icon name="Settings" />} open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Modal.Content>
          <LeylineSettingsForm theme={theme} layout={layout} />
        </Modal.Content>
      </Modal>
    </View>
  );
}
