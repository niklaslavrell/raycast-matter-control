import { Action, ActionPanel, Color, Icon, List, Toast, showToast } from "@raycast/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { runCli } from "./cli";
import { ErrorBoundary } from "./error-boundary";
import PairDeviceCommand from "./pair-device";
import { Endpoint, MatterSession } from "./matter-session";
import {
  Category,
  DT,
  SECTION_ORDER,
  buildView,
  categoryLabel,
  compactAccessoriesFor,
  fullAccessoriesFor,
  iconForCategory,
  primaryDeviceTypeName,
  renderDetailMetadata,
} from "./device-detail";
import { BrightnessForm, ColorForm, ColorTempForm } from "./forms";
import {
  BRIGHTNESS_STEP_PERCENT,
  COLOR_TEMP_STEP_KELVIN,
  RELATIVE_TIME_TICK_MS,
  hexToMatterColor,
  stepColorTemp,
  stepLevel,
} from "./format";

type NodeInfo = {
  nodeId: string;
  productName: string | null;
  vendorName: string | null;
  advertisedName: string | null;
};

type NodeStatus = "connecting" | "ready" | "error";

type NodeState = {
  info: NodeInfo;
  status: NodeStatus;
  endpoints: Endpoint[];
  error: string | null;
  lastUpdatedAt: number | null;
};

function nodeTitle(info: NodeInfo): string {
  return info.productName ?? info.advertisedName ?? `Node ${info.nodeId}`;
}

function listNodes(): Promise<NodeInfo[]> {
  return runCli<NodeInfo[]>("list");
}

const togglingKey = (nodeId: string, epId: number) => `${nodeId}:${epId}`;

export default function DevicesCommand() {
  return (
    <ErrorBoundary>
      <DevicesView />
    </ErrorBoundary>
  );
}

function DevicesView() {
  const [nodesById, setNodesById] = useState<Record<string, NodeState>>({});
  const [topLevelError, setTopLevelError] = useState<string | null>(null);
  const [isListingNodes, setIsListingNodes] = useState(true);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [isShowingDetail, setIsShowingDetail] = useState(false);
  const sessionsRef = useRef<Map<string, MatterSession>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function loadNodeEndpoints(info: NodeInfo, session: MatterSession) {
      try {
        await session.ready;
        const endpoints = await session.inspect();
        if (cancelled) return;
        setNodesById((prev) => ({
          ...prev,
          [info.nodeId]: {
            ...prev[info.nodeId],
            status: "ready",
            endpoints,
            lastUpdatedAt: Date.now(),
          },
        }));
      } catch (err) {
        if (cancelled) return;
        setNodesById((prev) => ({
          ...prev,
          [info.nodeId]: {
            ...prev[info.nodeId],
            status: "error",
            error: (err as Error).message,
          },
        }));
      }
    }

    async function bootstrap() {
      let nodes: NodeInfo[];
      try {
        nodes = await listNodes();
      } catch (err) {
        if (cancelled) return;
        setTopLevelError((err as Error).message);
        setIsListingNodes(false);
        return;
      }
      if (cancelled) return;
      setIsListingNodes(false);
      if (nodes.length === 0) return;

      const initialState: Record<string, NodeState> = {};
      for (const info of nodes) {
        initialState[info.nodeId] = {
          info,
          status: "connecting",
          endpoints: [],
          error: null,
          lastUpdatedAt: null,
        };
      }
      setNodesById(initialState);

      for (const info of nodes) {
        const session = new MatterSession(info.nodeId);
        sessionsRef.current.set(info.nodeId, session);
        void loadNodeEndpoints(info, session);
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
      for (const session of sessionsRef.current.values()) session.close();
      sessionsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (topLevelError) {
      showToast({ style: Toast.Style.Failure, title: "Failed to list devices", message: topLevelError });
    }
  }, [topLevelError]);

  function patchEndpoint(nodeId: string, epId: number, updates: Partial<Endpoint>) {
    setNodesById((prev) => {
      const node = prev[nodeId];
      if (!node) return prev;
      return {
        ...prev,
        [nodeId]: {
          ...node,
          endpoints: node.endpoints.map((endpoint) =>
            endpoint.endpointId === epId ? { ...endpoint, ...updates } : endpoint,
          ),
        },
      };
    });
  }

  async function refreshNode(nodeId: string, session: MatterSession) {
    try {
      const endpoints = await session.inspect();
      setNodesById((prev) => ({
        ...prev,
        [nodeId]: {
          ...prev[nodeId],
          status: "ready",
          endpoints,
          error: null,
          lastUpdatedAt: Date.now(),
        },
      }));
    } catch (err) {
      setNodesById((prev) => ({
        ...prev,
        [nodeId]: { ...prev[nodeId], status: "error", error: (err as Error).message },
      }));
    }
  }

  async function refreshAll() {
    const tasks: Promise<void>[] = [];
    for (const [nodeId, session] of sessionsRef.current.entries()) {
      tasks.push(refreshNode(nodeId, session));
    }
    if (tasks.length > 0) await Promise.all(tasks);
  }

  // Common wrapper for any per-endpoint operation. Handles optimistic update,
  // toggling-spinner state, animated toast, error rollback, and looking up the
  // right session by nodeId.
  async function runEndpointOp<T>(
    nodeId: string,
    endpoint: Endpoint,
    opts: {
      title: string;
      successTitle: (result: T) => string;
      failTitle: string;
      optimistic: Partial<Endpoint>;
      rollback: Partial<Endpoint>;
      reconcile?: (result: T) => Partial<Endpoint>;
      run: (session: MatterSession) => Promise<T>;
    },
  ): Promise<void> {
    const session = sessionsRef.current.get(nodeId);
    if (!session || endpoint.endpointId == null) return;
    const epId = endpoint.endpointId;
    const key = togglingKey(nodeId, epId);

    patchEndpoint(nodeId, epId, opts.optimistic);
    setToggling((current) => new Set(current).add(key));
    const toast = await showToast({ style: Toast.Style.Animated, title: opts.title });

    try {
      const result = await opts.run(session);
      if (opts.reconcile) patchEndpoint(nodeId, epId, opts.reconcile(result));
      toast.style = Toast.Style.Success;
      toast.title = opts.successTitle(result);
    } catch (err) {
      patchEndpoint(nodeId, epId, opts.rollback);
      toast.style = Toast.Style.Failure;
      toast.title = opts.failTitle;
      toast.message = (err as Error).message;
    } finally {
      setToggling((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  function handleSetOnOff(nodeId: string, endpoint: Endpoint, on: boolean) {
    return runEndpointOp(nodeId, endpoint, {
      title: `Turning ${on ? "on" : "off"}…`,
      successTitle: (result: { onOff: boolean | null }) => (result.onOff ? "Turned on" : "Turned off"),
      failTitle: on ? "Turn on failed" : "Turn off failed",
      optimistic: { onOff: on },
      rollback: { onOff: endpoint.onOff },
      reconcile: (result) => ({ onOff: result.onOff ?? on }),
      run: (session) => session.setOnOff(endpoint.endpointId!, on),
    });
  }

  function handleSetLevel(nodeId: string, endpoint: Endpoint, matterLevel: number) {
    const clamped = Math.max(0, Math.min(254, Math.round(matterLevel)));
    const nextOn = clamped > 0;
    const percent = Math.round((clamped / 254) * 100);
    return runEndpointOp(nodeId, endpoint, {
      title: nextOn ? `Setting brightness to ${percent}%…` : "Turning off…",
      successTitle: () => (nextOn ? `Brightness ${percent}%` : "Turned off"),
      failTitle: "Brightness change failed",
      optimistic: { currentLevel: clamped, onOff: nextOn },
      rollback: { currentLevel: endpoint.currentLevel, onOff: endpoint.onOff },
      run: (session) => session.setLevel(endpoint.endpointId!, clamped),
    });
  }

  function handleSetColor(nodeId: string, endpoint: Endpoint, hex: string) {
    const matter = hexToMatterColor(hex);
    if (!matter) {
      showToast({ style: Toast.Style.Failure, title: "Invalid color", message: `Could not parse ${hex}` });
      return;
    }
    return runEndpointOp(nodeId, endpoint, {
      title: `Setting color to ${hex.toUpperCase()}…`,
      successTitle: () => `Color ${hex.toUpperCase()}`,
      failTitle: "Color change failed",
      optimistic: { currentHue: matter.hue, currentSaturation: matter.saturation, colorMode: 0 },
      rollback: {
        currentHue: endpoint.currentHue,
        currentSaturation: endpoint.currentSaturation,
        colorMode: endpoint.colorMode,
      },
      run: (session) => session.setColor(endpoint.endpointId!, matter.hue, matter.saturation),
    });
  }

  function handleSetColorTemp(nodeId: string, endpoint: Endpoint, mireds: number) {
    const clamped = Math.max(1, Math.round(mireds));
    return runEndpointOp(nodeId, endpoint, {
      title: `Setting color temp to ${Math.round(1_000_000 / clamped)} K…`,
      successTitle: () => `Color temp ${Math.round(1_000_000 / clamped)} K`,
      failTitle: "Color temp change failed",
      optimistic: { colorTemperatureMireds: clamped, colorMode: 2 },
      rollback: { colorTemperatureMireds: endpoint.colorTemperatureMireds, colorMode: endpoint.colorMode },
      run: (session) => session.setColorTemp(endpoint.endpointId!, clamped),
    });
  }

  type FlatItem = {
    nodeId: string;
    nodeTitle: string;
    endpoint: Endpoint;
    children: Endpoint[];
    category: Category;
    lastUpdatedAt: number | null;
  };

  const flatItems: FlatItem[] = useMemo(() => {
    const items: FlatItem[] = [];
    for (const state of Object.values(nodesById)) {
      if (state.status !== "ready") continue;
      const title = nodeTitle(state.info);
      for (const view of buildView(state.endpoints)) {
        items.push({
          nodeId: state.info.nodeId,
          nodeTitle: title,
          endpoint: view.endpoint,
          children: view.children,
          category: view.category,
          lastUpdatedAt: state.lastUpdatedAt,
        });
      }
    }
    return items;
  }, [nodesById]);

  // Tick once every 10s so the "Updated Xs ago" line in the detail pane stays
  // meaningful while the view is open. Only runs when there's something to update.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (Object.keys(nodesById).length === 0) return;
    const id = setInterval(() => setNowTick((tick) => tick + 1), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(id);
  }, [nodesById]);

  // Sort within each category: reachable devices first, then alphabetically by
  // display name. Use the user's system locale so accented characters sort the
  // way they'd expect in their language (Swedish Å/Ä/Ö after Z; German Ä/Ö/Ü
  // with their base letters; etc.). `numeric: true` makes "Lampa 10" come
  // after "Lampa 2", not after "Lampa 1".
  const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

  function displayNameForSort(item: FlatItem): string {
    const endpoint = item.endpoint;
    return (endpoint.nodeLabel ?? endpoint.productName ?? item.nodeTitle ?? "").toLowerCase();
  }

  function compareDevices(a: FlatItem, b: FlatItem): number {
    // null reachable → treat as reachable (we just don't know).
    const aReach = a.endpoint.reachable !== false;
    const bReach = b.endpoint.reachable !== false;
    if (aReach !== bReach) return aReach ? -1 : 1;
    return NAME_COLLATOR.compare(displayNameForSort(a), displayNameForSort(b));
  }

  const grouped = useMemo(() => {
    const groups = new Map<Category, FlatItem[]>();
    for (const item of flatItems) {
      const existing = groups.get(item.category);
      if (existing) existing.push(item);
      else groups.set(item.category, [item]);
    }
    for (const items of groups.values()) items.sort(compareDevices);
    return groups;
  }, [flatItems]);

  const accessoriesFor = isShowingDetail ? compactAccessoriesFor : fullAccessoriesFor;
  const allNodes = Object.values(nodesById);
  const connecting = allNodes.filter((node) => node.status === "connecting");
  const erroredNodes = allNodes.filter((node) => node.status === "error");
  const totalDevices = flatItems.length;
  const isStillLoading = isListingNodes || connecting.length > 0;

  return (
    <List
      isLoading={isStillLoading}
      isShowingDetail={isShowingDetail}
      searchBarPlaceholder={
        totalDevices > 0
          ? `Search ${totalDevices} device${totalDevices === 1 ? "" : "s"}…`
          : isStillLoading
            ? "Loading devices…"
            : "No devices"
      }
    >
      {connecting.length > 0 && (
        <List.Section title="Connecting" subtitle={String(connecting.length)}>
          {connecting.map((node) => (
            <List.Item
              key={`connecting-${node.info.nodeId}`}
              icon={{ source: Icon.CircleProgress, tintColor: Color.SecondaryText }}
              title={nodeTitle(node.info)}
              subtitle="Establishing Matter session…"
            />
          ))}
        </List.Section>
      )}

      {topLevelError && (
        <List.Section title="Error">
          <List.Item
            key="top-error"
            icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
            title="Failed to list hubs"
            subtitle={topLevelError}
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="Copy Error Message" content={topLevelError} />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {erroredNodes.length > 0 && (
        <List.Section title="Connection Errors" subtitle={String(erroredNodes.length)}>
          {erroredNodes.map((node) => (
            <List.Item
              key={`err-${node.info.nodeId}`}
              icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
              title={nodeTitle(node.info)}
              subtitle={node.error ?? "Connection failed"}
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard title="Copy Error Message" content={node.error ?? "Connection failed"} />
                  <Action title="Retry All" icon={Icon.ArrowClockwise} onAction={refreshAll} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {SECTION_ORDER.map((category) => {
        const items = grouped.get(category) ?? [];
        if (items.length === 0) return null;
        return (
          <List.Section key={category} title={categoryLabel(category)} subtitle={String(items.length)}>
            {items.map(({ nodeId, nodeTitle, endpoint, children, lastUpdatedAt }) => {
              const isOnlyEndpointOnNode =
                allNodes
                  .find((node) => node.info.nodeId === nodeId)
                  ?.endpoints.filter((endpoint) => endpoint.parentEndpointId == null || endpoint.parentEndpointId !== 0)
                  .length === 1 || false;
              const name =
                endpoint.nodeLabel ??
                endpoint.productName ??
                (isOnlyEndpointOnNode ? nodeTitle : null) ??
                `${primaryDeviceTypeName(endpoint)} ${endpoint.endpointId ?? ""}`.trim();
              const isToggling = endpoint.endpointId != null && toggling.has(togglingKey(nodeId, endpoint.endpointId));
              const isControllable = category === "light" || category === "outlet" || category === "other";
              const canToggle =
                isControllable && endpoint.onOff != null && endpoint.endpointId != null && endpoint.reachable !== false;

              return (
                <List.Item
                  key={`${nodeId}:${endpoint.endpointId ?? Math.random()}`}
                  icon={iconForCategory(category, endpoint, children)}
                  title={name}
                  keywords={[categoryLabel(category), primaryDeviceTypeName(endpoint)]}
                  accessories={accessoriesFor(category, endpoint, children, isToggling)}
                  detail={
                    <List.Item.Detail metadata={renderDetailMetadata(category, endpoint, children, lastUpdatedAt)} />
                  }
                  actions={
                    <ActionPanel>
                      {canToggle && (
                        <>
                          <Action
                            title={endpoint.onOff ? "Turn Off" : "Turn On"}
                            icon={endpoint.onOff ? Icon.LightBulbOff : Icon.LightBulb}
                            onAction={() => handleSetOnOff(nodeId, endpoint, !endpoint.onOff)}
                          />
                          <Action
                            title={endpoint.onOff ? "Turn On" : "Turn Off"}
                            icon={endpoint.onOff ? Icon.LightBulb : Icon.LightBulbOff}
                            onAction={() => handleSetOnOff(nodeId, endpoint, !!endpoint.onOff)}
                          />
                        </>
                      )}
                      {category === "light" && endpoint.endpointId != null && endpoint.reachable !== false && (
                        <>
                          <Action
                            title="Brighter"
                            icon={Icon.PlusCircle}
                            shortcut={{ modifiers: ["cmd", "shift"], key: "arrowUp" }}
                            onAction={() =>
                              handleSetLevel(
                                nodeId,
                                endpoint,
                                stepLevel(endpoint.currentLevel, +BRIGHTNESS_STEP_PERCENT),
                              )
                            }
                          />
                          <Action
                            title="Dimmer"
                            icon={Icon.MinusCircle}
                            shortcut={{ modifiers: ["cmd", "shift"], key: "arrowDown" }}
                            onAction={() =>
                              handleSetLevel(
                                nodeId,
                                endpoint,
                                stepLevel(endpoint.currentLevel, -BRIGHTNESS_STEP_PERCENT),
                              )
                            }
                          />
                          <Action.Push
                            title="Set Brightness…"
                            icon={Icon.LightBulb}
                            shortcut={{ modifiers: ["cmd"], key: "b" }}
                            target={
                              <BrightnessForm
                                endpoint={endpoint}
                                onSubmit={(matterLevel) => handleSetLevel(nodeId, endpoint, matterLevel)}
                              />
                            }
                          />
                          {endpoint.deviceTypes.some((deviceType) => deviceType.code === DT.ExtendedColorLight) && (
                            <Action.Push
                              title="Set Color…"
                              icon={Icon.EyeDropper}
                              shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                              target={
                                <ColorForm
                                  endpoint={endpoint}
                                  onSubmit={(hex) => handleSetColor(nodeId, endpoint, hex)}
                                />
                              }
                            />
                          )}
                          {endpoint.deviceTypes.some(
                            (deviceType) =>
                              deviceType.code === DT.ColorTemperatureLight || deviceType.code === DT.ExtendedColorLight,
                          ) && (
                            <>
                              <Action
                                title="Warmer"
                                icon={Icon.Sun}
                                shortcut={{ modifiers: ["cmd", "shift"], key: "arrowRight" }}
                                onAction={() =>
                                  handleSetColorTemp(nodeId, endpoint, stepColorTemp(endpoint, -COLOR_TEMP_STEP_KELVIN))
                                }
                              />
                              <Action
                                title="Cooler"
                                icon={Icon.Snowflake}
                                shortcut={{ modifiers: ["cmd", "shift"], key: "arrowLeft" }}
                                onAction={() =>
                                  handleSetColorTemp(nodeId, endpoint, stepColorTemp(endpoint, +COLOR_TEMP_STEP_KELVIN))
                                }
                              />
                              <Action.Push
                                title="Set Color Temperature…"
                                icon={Icon.Temperature}
                                shortcut={{ modifiers: ["cmd"], key: "t" }}
                                target={
                                  <ColorTempForm
                                    endpoint={endpoint}
                                    onSubmit={(mireds) => handleSetColorTemp(nodeId, endpoint, mireds)}
                                  />
                                }
                              />
                            </>
                          )}
                        </>
                      )}
                      <Action
                        title={isShowingDetail ? "Hide Details" : "Show Details"}
                        icon={Icon.Sidebar}
                        shortcut={{ modifiers: ["cmd"], key: "d" }}
                        onAction={() => setIsShowingDetail((showing) => !showing)}
                      />
                      <Action
                        title="Refresh All"
                        icon={Icon.ArrowClockwise}
                        shortcut={{ modifiers: ["cmd"], key: "r" }}
                        onAction={refreshAll}
                      />
                      {endpoint.endpointId != null && (
                        <Action.CopyToClipboard title="Copy Endpoint Id" content={String(endpoint.endpointId)} />
                      )}
                      <Action.CopyToClipboard title="Copy Hub Node Id" content={nodeId} />
                    </ActionPanel>
                  }
                />
              );
            })}
          </List.Section>
        );
      })}

      <List.EmptyView
        icon={Icon.Plug}
        title={topLevelError ? "Failed to list devices" : isStillLoading ? "Loading…" : "No devices"}
        description={
          topLevelError ??
          (isStillLoading
            ? "Discovering paired hubs and devices."
            : "Pair a device with this controller to see it here.")
        }
        actions={
          !isStillLoading && !topLevelError ? (
            <ActionPanel>
              <Action.Push title="Pair Device" icon={Icon.Plug} target={<PairDeviceCommand />} />
            </ActionPanel>
          ) : undefined
        }
      />
    </List>
  );
}
