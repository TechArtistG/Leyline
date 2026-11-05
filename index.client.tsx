import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { GraphView } from "./client/graph-view";
import { LEYLINE_ICON } from "./client/logo";
import { LeylineSettingsScreen } from "./client/settings/form";

const HUB = "hub";
const PANEL = "graph";

function HubScreen({ theme, layout, host }: PluginScreenProps) {
  return (
    <GraphView
      theme={theme}
      layout={layout}
      surface="hub"
      hostId={host.id}
      hostLabel={host.label}
      caption={`Leyline hub · host ${host.label}`}
    />
  );
}

function WorkspacePanel({ theme, layout, host, workspaceId }: PluginWorkspacePanelProps) {
  return (
    <GraphView
      theme={theme}
      layout={layout}
      surface="workspace"
      hostId={host.id}
      hostLabel={host.label}
      workspaceId={workspaceId}
      caption={`Leyline · workspace ${workspaceId}`}
    />
  );
}

function HubItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon={LEYLINE_ICON}
      active={currentScreen?.screenId === HUB}
      onPress={() => openScreen({ screenId: HUB })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addSettingsScreen({ id: "settings", title: "Leyline", icon: LEYLINE_ICON, Component: LeylineSettingsScreen }),
    client.addScreen({ id: HUB, title: "Leyline", Component: HubScreen }),
    client.addSidebarHeaderItem({ id: HUB, title: "Leyline", Component: HubItem }),
    client.addWorkspacePanel({
      id: PANEL,
      title: "Leyline",
      icon: LEYLINE_ICON,
      locations: ["workspace", "explorer"],
      Component: WorkspacePanel,
    }),
  ];
  return () => removers.forEach((remove) => remove());
}
