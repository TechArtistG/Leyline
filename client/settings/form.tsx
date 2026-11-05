import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginHostProps, type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import {
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text } from "react-native";
import { GRAPH_MODES, GRAPH_MODE_LABELS, type GraphMode } from "../../shared/graph";
import { type LeylineSettings, LeylineSettingsSchema, leylineSettings } from "../../shared/settings";

type NumericKey = "labelFontSizePx" | "labelMaxFontSizePx" | "gitRefreshSeconds";

const MODE_OPTIONS: ReadonlyArray<{ label: string; value: GraphMode }> = GRAPH_MODES.map((mode) => ({
  label: GRAPH_MODE_LABELS[mode],
  value: mode,
}));

/** Parses a numeric field against its schema; returns the value or the validation message. */
function parseNumeric(key: NumericKey, text: string): { value: number } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { error: "Required" };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { error: "Must be a number" };
  const result = LeylineSettingsSchema.shape[key].safeParse(n);
  if (result.success) return { value: result.data };
  return { error: result.error.issues[0]?.message ?? "Invalid value" };
}

/**
 * Edits Leyline's global settings. Every change saves immediately against the displayed revision;
 * a failed save surfaces as a toast and the form re-shows the stored values.
 */
export function LeylineSettingsForm({ theme, layout }: { theme: PluginTheme; layout: PluginHostProps["layout"] }) {
  const settings = useSettings(leylineSettings);
  const toast = useToast();
  // Inline validation errors for the free-text numeric rows; the last valid value is what gets saved.
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<NumericKey, string>>>({});
  // Bumped on reset so the uncontrolled inputs remount with the stored defaults.
  const [inputEpoch, setInputEpoch] = useState(0);
  const hints = !layout.compact;

  // Toast each distinct save failure once; `toast` identity is not relied on for dedupe.
  const lastToasted = useRef<string | null>(null);
  useEffect(() => {
    if (settings.saveError === lastToasted.current) return;
    lastToasted.current = settings.saveError;
    if (settings.saveError) toast.error(`Leyline settings: ${settings.saveError}`);
  }, [settings.saveError, toast]);

  const ready = settings.status === "ready" ? settings : null;
  const values = ready?.values;
  const revision = ready?.revision;

  const update = useCallback(
    <K extends keyof LeylineSettings>(key: K, next: LeylineSettings[K]) => {
      if (!values || revision === undefined) return;
      const draft: LeylineSettings = { ...values };
      draft[key] = next;
      void settings.save(draft, revision);
    },
    [revision, settings, values],
  );

  const updateNumeric = useCallback(
    (key: NumericKey, text: string) => {
      const parsed = parseNumeric(key, text);
      setFieldErrors((prev) => {
        const error = "error" in parsed ? parsed.error : undefined;
        if (prev[key] === error) return prev;
        return { ...prev, [key]: error };
      });
      if ("value" in parsed && values && values[key] !== parsed.value) update(key, parsed.value);
    },
    [update, values],
  );

  const reset = useCallback(() => {
    void settings.reset().then((ok) => {
      if (!ok) return;
      setFieldErrors({});
      setInputEpoch((n) => n + 1);
    });
  }, [settings]);

  const textStyle = useMemo(
    () => ({ color: theme.colors.foregroundMuted, fontSize: 12, padding: 12 }),
    [theme],
  );

  if (settings.status === "loading") return <Text style={textStyle}>Loading Leyline settings…</Text>;
  if (settings.status === "error") return <Text style={textStyle}>Leyline settings unavailable: {settings.error}</Text>;
  if (settings.status === "invalid" || !values) {
    return (
      <>
        <Text style={textStyle}>Stored Leyline settings are invalid: {settings.status === "invalid" ? settings.error : ""}</Text>
        <SettingsSection title="Reset">
          <SettingsCard>
            <SettingsAction label="Restore defaults" actionLabel="Reset" onPress={reset} />
          </SettingsCard>
        </SettingsSection>
      </>
    );
  }

  return (
    <>
      <SettingsSection title="Layout">
        <SettingsCard>
          <SettingsSelect<GraphMode>
            label="Default layout"
            hint={hints ? "Mode a new graph viewport opens in" : undefined}
            value={values.defaultMode}
            options={MODE_OPTIONS}
            onValueChange={(mode) => update("defaultMode", mode)}
          />
          <SettingsSwitch
            label="Collapse hosts"
            hint={hints ? "Attach repos directly to the universe instead of per-host nodes" : undefined}
            value={values.collapseHosts}
            onValueChange={(on) => update("collapseHosts", on)}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Display">
        <SettingsCard>
          <SettingsSwitch
            label="Show project spheres"
            hint={hints ? "Containment sphere (3D) or hull (2D) around each repo" : undefined}
            value={values.showClusters}
            onValueChange={(on) => update("showClusters", on)}
          />
          <SettingsSwitch
            label="Show agent rings"
            hint={hints ? "Rings around worktrees for each anchored agent" : undefined}
            value={values.showAgentRings}
            onValueChange={(on) => update("showAgentRings", on)}
          />
          <SettingsSwitch
            label="Show file nodes"
            hint={hints ? "Files below branches; hidden by default" : undefined}
            value={values.showFiles}
            onValueChange={(on) => update("showFiles", on)}
          />
          <SettingsInput
            key={`labelFontSizePx:${inputEpoch}`}
            label="Label size (px)"
            hint={hints ? "8–32; labels never render smaller" : undefined}
            error={fieldErrors.labelFontSizePx ?? null}
            initialValue={String(values.labelFontSizePx)}
            placeholder="13"
            onChangeText={(text) => updateNumeric("labelFontSizePx", text)}
          />
          <SettingsInput
            key={`labelMaxFontSizePx:${inputEpoch}`}
            label="Max label size (px)"
            hint={hints ? "8–64; labels grow with zoom up to this" : undefined}
            error={fieldErrors.labelMaxFontSizePx ?? null}
            initialValue={String(values.labelMaxFontSizePx)}
            placeholder="22"
            onChangeText={(text) => updateNumeric("labelMaxFontSizePx", text)}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Topology">
        <SettingsCard>
          <SettingsSwitch
            label="Show git-only worktrees"
            hint={hints ? "Worktrees that are not Paseo workspaces" : undefined}
            value={values.showGitOnlyWorktrees}
            onValueChange={(on) => update("showGitOnlyWorktrees", on)}
          />
          <SettingsSwitch
            label="Show other local branches"
            hint={hints ? "Branches not checked out in any worktree" : undefined}
            value={values.showOtherBranches}
            onValueChange={(on) => update("showOtherBranches", on)}
          />
          <SettingsInput
            key={`gitRefreshSeconds:${inputEpoch}`}
            label="Git refresh (seconds)"
            hint={hints ? "3–300; how often branches and worktrees are re-read" : undefined}
            error={fieldErrors.gitRefreshSeconds ?? null}
            initialValue={String(values.gitRefreshSeconds)}
            placeholder="15"
            onChangeText={(text) => updateNumeric("gitRefreshSeconds", text)}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Reset">
        <SettingsCard>
          <SettingsAction
            label="Restore defaults"
            hint={hints ? "Reverts every Leyline setting on this host" : undefined}
            actionLabel="Reset"
            onPress={reset}
            disabled={settings.saving}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

/** Settings → Plugins → Leyline. */
export function LeylineSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <LeylineSettingsForm theme={theme} layout={layout} />
    </ScrollView>
  );
}
