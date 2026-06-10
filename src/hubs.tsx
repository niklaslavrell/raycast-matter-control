import { Action, ActionPanel, Alert, Color, Icon, List, Toast, confirmAlert, showToast } from "@raycast/api";
import { Fragment, useEffect, useRef, useState } from "react";
import { assertNever } from "./assert";
import { DeviceDetail, primaryDeviceTypeName } from "./device-detail";
import { ErrorBoundary } from "./error-boundary";
import { RELATIVE_TIME_TICK_MS, formatRelativeTime, formatUptime } from "./format";
import { HubInfo, MatterSession, NodeInfo } from "./matter-session";

type DiagStatus = "idle" | "loading" | "loaded" | "error";

// Matter vendor IDs we recognize. 0xFFF1 is the Matter test vendor; IKEA dev
// builds and various test devices use it.
const VENDOR_NAMES: Record<number, string> = {
  0xfff1: "Test Vendor 1",
  0xfff2: "Test Vendor 2",
  0xfff3: "Test Vendor 3",
  0xfff4: "Test Vendor 4",
};

function vendorName(vendorId: number | null): string {
  if (vendorId == null) return "Unknown";
  return VENDOR_NAMES[vendorId] ?? `Vendor 0x${vendorId.toString(16).toUpperCase()} (${vendorId})`;
}

const COMMISSIONING_LABELS: Record<number, string> = {
  0: "Closed",
  1: "Open (Enhanced)",
  2: "Open (Basic)",
};

function shortAddress(addr: string | null): string {
  if (!addr) return "Offline";
  return addr.replace(/^udp:\/\//, "").replace(/:\d+$/, "");
}

function nodeTitle(node: NodeInfo): string {
  return node.productName ?? node.advertisedName ?? `Node ${node.nodeId}`;
}

export default function HubsCommand() {
  return (
    <ErrorBoundary>
      <HubsView />
    </ErrorBoundary>
  );
}

function HubsView() {
  const sessionRef = useRef<MatterSession | null>(null);
  const [data, setData] = useState<NodeInfo[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const [isShowingDetail, setIsShowingDetail] = useState(false);
  const [diagStatus, setDiagStatus] = useState<Record<string, DiagStatus>>({});
  const [diagData, setDiagData] = useState<Record<string, HubInfo>>({});
  const [diagError, setDiagError] = useState<Record<string, string>>({});
  const [diagLoadedAt, setDiagLoadedAt] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    const session = new MatterSession();
    sessionRef.current = session;

    async function bootstrap() {
      try {
        await session.ready;
        const nodes = await session.listNodes();
        if (cancelled) return;
        setData(nodes);
      } catch (err) {
        if (cancelled) return;
        setError(err as Error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void bootstrap();

    return () => {
      cancelled = true;
      session.close();
      sessionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (error) {
      showToast({ style: Toast.Style.Failure, title: "Failed to list hubs", message: error.message });
    }
  }, [error]);

  // Tick once every 10s so "Loaded Xs ago" stays current.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (Object.keys(diagLoadedAt).length === 0) return;
    const id = setInterval(() => setNowTick((tick) => tick + 1), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(id);
  }, [diagLoadedAt]);

  async function revalidate() {
    const session = sessionRef.current;
    if (!session) return;
    try {
      const nodes = await session.listNodes();
      setData(nodes);
    } catch (err) {
      setError(err as Error);
    }
  }

  async function loadDiagnostics(nodeId: string) {
    const session = sessionRef.current;
    if (!session) return;
    setDiagStatus((current) => ({ ...current, [nodeId]: "loading" }));
    setDiagError((current) => {
      const next = { ...current };
      delete next[nodeId];
      return next;
    });
    try {
      const info = await session.hubInfo(nodeId);
      setDiagData((current) => ({ ...current, [nodeId]: info }));
      setDiagLoadedAt((current) => ({ ...current, [nodeId]: Date.now() }));
      setDiagStatus((current) => ({ ...current, [nodeId]: "loaded" }));
    } catch (err) {
      setDiagError((current) => ({ ...current, [nodeId]: (err as Error).message }));
      setDiagStatus((current) => ({ ...current, [nodeId]: "error" }));
    }
  }

  async function handleUnpair(node: NodeInfo) {
    const session = sessionRef.current;
    if (!session) return;
    const title = nodeTitle(node);
    const confirmed = await confirmAlert({
      title: "Unpair this device?",
      message: `${title} will be removed from this controller. To pair it again you'll need to factory reset the device first.`,
      icon: Icon.Trash,
      primaryAction: { title: "Unpair", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Unpairing…",
      message: "Removing fabric from device. This can take a moment.",
    });
    try {
      await session.decommission(node.nodeId);
      toast.style = Toast.Style.Success;
      toast.title = "Unpaired";
      toast.message = title;
      await revalidate();
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "Unpair failed";
      toast.message = (err as Error).message;
    }
  }

  const totalHubs = data?.length ?? 0;

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={isShowingDetail}
      searchBarPlaceholder={
        totalHubs > 0
          ? `Search ${totalHubs} hub${totalHubs === 1 ? "" : "s"}…`
          : isLoading
            ? "Loading hubs…"
            : "No hubs"
      }
    >
      {(data ?? []).map((node) => {
        const title = nodeTitle(node);
        const online = node.operationalAddress != null;
        const status = diagStatus[node.nodeId] ?? "idle";
        const info = diagData[node.nodeId];
        const errMsg = diagError[node.nodeId];
        const loadedAt = diagLoadedAt[node.nodeId];

        return (
          <List.Item
            key={node.nodeId}
            icon={{
              source: Icon.AppWindowGrid3x3,
              tintColor: online ? Color.PrimaryText : Color.SecondaryText,
            }}
            title={title}
            subtitle={isShowingDetail ? undefined : (node.vendorName ?? undefined)}
            accessories={[
              {
                tag: {
                  value: online ? "Online" : "Offline",
                  color: online ? Color.Green : Color.SecondaryText,
                },
              },
            ]}
            detail={<List.Item.Detail metadata={renderHubDetail(node, status, info, errMsg, loadedAt)} />}
            actions={
              <ActionPanel>
                {sessionRef.current && (
                  <Action.Push
                    title="Show Endpoints"
                    icon={Icon.AppWindowList}
                    target={<DeviceDetail nodeId={node.nodeId} title={title} session={sessionRef.current} />}
                  />
                )}
                <Action
                  title={isShowingDetail ? "Hide Details" : "Show Details"}
                  icon={Icon.Sidebar}
                  shortcut={{ modifiers: ["cmd"], key: "d" }}
                  onAction={() => {
                    const nextShowing = !isShowingDetail;
                    setIsShowingDetail(nextShowing);
                    // Auto-load when the user opens the pane for the first time.
                    if (nextShowing && status === "idle") {
                      loadDiagnostics(node.nodeId);
                    }
                  }}
                />
                <Action
                  title={status === "loaded" ? "Reload Diagnostics" : "Load Diagnostics"}
                  icon={Icon.Download}
                  shortcut={{ modifiers: ["cmd"], key: "l" }}
                  onAction={() => loadDiagnostics(node.nodeId)}
                />
                <Action title="Refresh Hub List" icon={Icon.ArrowClockwise} onAction={revalidate} />
                <Action.CopyToClipboard title="Copy Node Id" content={node.nodeId} />
                {node.operationalAddress && (
                  <Action.CopyToClipboard title="Copy Operational Address" content={node.operationalAddress} />
                )}
                <Action
                  title="Unpair Device…"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={() => handleUnpair(node)}
                />
              </ActionPanel>
            }
          />
        );
      })}
      <List.EmptyView
        icon={Icon.Plug}
        title={isLoading ? "Loading hubs…" : "No paired hubs"}
        description={isLoading ? undefined : "Pair a device with this controller using the Pair Device command."}
      />
    </List>
  );
}

const PAIRING_WINDOW_CLOSED = 0;
const TOP_DEVICE_TYPES_TO_SHOW = 8;

const M = List.Item.Detail.Metadata;

function buildIdentitySection(node: NodeInfo, info: HubInfo | undefined): React.ReactNode[] {
  const online = node.operationalAddress != null;
  const items: React.ReactNode[] = [];
  if (node.productName) items.push(<M.Label key="product" title="Product" text={node.productName} />);
  if (node.vendorName) items.push(<M.Label key="vendor" title="Vendor" text={node.vendorName} />);
  if (info?.basicInformation.productLabel)
    items.push(<M.Label key="label" title="Label" text={info.basicInformation.productLabel} />);
  if (node.advertisedName) items.push(<M.Label key="adv" title="Advertised Name" text={node.advertisedName} />);
  items.push(
    <M.TagList key="status" title="Status">
      <M.TagList.Item text={online ? "Online" : "Offline"} color={online ? Color.Green : Color.SecondaryText} />
    </M.TagList>,
  );
  if (node.operationalAddress)
    items.push(<M.Label key="addr" title="Operational Address" text={shortAddress(node.operationalAddress)} />);
  items.push(<M.Label key="nodeId" title="Node ID" text={node.nodeId} />);
  return items;
}

function buildLoadedDiagnosticsItems(info: HubInfo): React.ReactNode[] {
  const basic = info.basicInformation;
  const items: React.ReactNode[] = [];
  if (basic.softwareVersion) items.push(<M.Label key="sw" title="Firmware" text={basic.softwareVersion} />);
  if (basic.hardwareVersion) items.push(<M.Label key="hw" title="Hardware" text={basic.hardwareVersion} />);
  if (basic.serialNumber) items.push(<M.Label key="sn" title="Serial" text={basic.serialNumber} />);
  if (basic.partNumber) items.push(<M.Label key="pn" title="Part Number" text={basic.partNumber} />);
  if (basic.uniqueId) items.push(<M.Label key="uid" title="Unique ID" text={basic.uniqueId} />);
  if (basic.manufacturingDate)
    items.push(<M.Label key="mfg" title="Manufacturing Date" text={basic.manufacturingDate} />);
  return items;
}

function buildDiagnosticsSection(
  status: DiagStatus,
  info: HubInfo | undefined,
  errMsg: string | undefined,
): React.ReactNode[] {
  switch (status) {
    case "idle":
      return [
        <M.Label key="hint" title="Diagnostics" text="Press Cmd+L to load firmware, uptime, fabrics, endpoints" />,
      ];
    case "loading":
      return [<M.Label key="loading" title="Diagnostics" text="Loading…" />];
    case "error":
      return [<M.Label key="err" title="Diagnostics" text={errMsg ?? "Failed to load"} />];
    case "loaded":
      return info ? buildLoadedDiagnosticsItems(info) : [];
    default:
      assertNever(status, "unknown DiagStatus in buildDiagnosticsSection");
  }
}

function buildOperationalSection(info: HubInfo): React.ReactNode[] {
  const diagnostics = info.diagnostics;
  const items: React.ReactNode[] = [];
  items.push(<M.Label key="up" title="Uptime" text={formatUptime(diagnostics.upTimeSeconds)} />);
  if (diagnostics.totalOperationalHours != null)
    items.push(
      <M.Label key="tot" title="Total Hours" text={`${diagnostics.totalOperationalHours.toLocaleString()} h`} />,
    );
  if (diagnostics.rebootCount != null)
    items.push(<M.Label key="rb" title="Reboot Count" text={String(diagnostics.rebootCount)} />);
  const window = info.commissioning.windowStatus;
  if (window != null) {
    const label = COMMISSIONING_LABELS[window] ?? `Status ${window}`;
    items.push(
      <M.TagList key="cw" title="Pairing Window">
        <M.TagList.Item text={label} color={window === PAIRING_WINDOW_CLOSED ? Color.SecondaryText : Color.Yellow} />
      </M.TagList>,
    );
  }
  return items;
}

function buildEndpointsSection(info: HubInfo): React.ReactNode[] {
  const items: React.ReactNode[] = [
    <M.Label key="endpoint-total" title="Endpoints" text={String(info.endpoints.length)} />,
  ];
  const counts: Record<string, number> = {};
  for (const endpoint of info.endpoints) {
    const name = primaryDeviceTypeName(endpoint);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted.slice(0, TOP_DEVICE_TYPES_TO_SHOW)) {
    items.push(<M.Label key={`ct-${name}`} title={name} text={String(count)} />);
  }
  return items;
}

function buildFabricsSection(info: HubInfo): React.ReactNode[] {
  if (info.fabrics.length === 0) {
    return [<M.Label key="no-fab" title="Fabrics" text="(none reported)" />];
  }
  const items: React.ReactNode[] = [<M.Label key="fab-count" title="Fabrics" text={String(info.fabrics.length)} />];
  for (const fabric of info.fabrics) {
    const title = `Fabric ${fabric.fabricIndex ?? "?"}`;
    const vendor = vendorName(fabric.vendorId);
    const labelText = fabric.label ? `${fabric.label} — ${vendor}` : vendor;
    items.push(<M.Label key={`fab-${fabric.fabricIndex}`} title={title} text={labelText} />);
  }
  return items;
}

function renderHubDetail(
  node: NodeInfo,
  status: DiagStatus,
  info: HubInfo | undefined,
  errMsg: string | undefined,
  loadedAt: number | undefined,
) {
  const sections: React.ReactNode[][] = [
    buildIdentitySection(node, info),
    buildDiagnosticsSection(status, info, errMsg),
  ];
  const hasFullInfo = status === "loaded" && info;
  if (hasFullInfo) {
    sections.push(buildOperationalSection(info));
    sections.push(buildEndpointsSection(info));
    sections.push(buildFabricsSection(info));
  }
  if (loadedAt != null) {
    sections.push([<M.Label key="loaded" title="Loaded" text={formatRelativeTime(loadedAt)} />]);
  }
  const nonEmpty = sections.filter((section) => section.length > 0);

  return (
    <M>
      {nonEmpty.map((section, index) => (
        <Fragment key={index}>
          {index > 0 && <M.Separator />}
          {section}
        </Fragment>
      ))}
    </M>
  );
}
