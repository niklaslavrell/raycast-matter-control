import { Action, ActionPanel, Color, Icon, List, Toast, showToast } from "@raycast/api";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { assertNever } from "./assert";
import { DeviceType, Endpoint, MatterSession } from "./matter-session";
import { BrightnessForm, ColorForm, ColorTempForm, RenameForm } from "./forms";
import {
  BATTERY_CHARGE_LABELS,
  BRIGHTNESS_STEP_PERCENT,
  COLOR_TEMP_STEP_KELVIN,
  LOW_BATTERY_PERCENT,
  MATTER_LEVEL_MAX,
  POLLUTANT_KEYS,
  RELATIVE_TIME_TICK_MS,
  activeColorHex,
  aqiColor,
  aqiLabel,
  batteryChargeColor,
  colorTempKelvin,
  ctRange,
  formatConcentration,
  formatRelativeTime,
  hexToMatterColor,
  levelPercent,
  levelToPercentNum,
  matterHueToDegrees,
  matterSaturationToPercent,
  miredsToKelvin,
  stepColorTemp,
  stepLevel,
} from "./format";

// Matter device type codes (from the Matter device library spec).
export const DT = {
  Aggregator: 14,
  GenericSwitch: 15,
  PowerSource: 17,
  BridgedNode: 19,
  OnOffLight: 256,
  DimmableLight: 257,
  OnOffPlugInUnit: 266,
  ColorTemperatureLight: 268,
  ExtendedColorLight: 269,
  AirQualitySensor: 44,
  TemperatureSensor: 770,
  HumiditySensor: 775,
} as const;

export const LIGHT_TYPES = new Set<number>([
  DT.OnOffLight,
  DT.DimmableLight,
  DT.ColorTemperatureLight,
  DT.ExtendedColorLight,
]);

export const SENSOR_TYPES = new Set<number>([DT.TemperatureSensor, DT.HumiditySensor, DT.AirQualitySensor]);

export type Category = "light" | "outlet" | "sensor" | "remote" | "other";

export function primaryDeviceType(endpoint: Endpoint): { name: string; code: number } | null {
  const isStructural = (deviceType: DeviceType) =>
    deviceType.code === DT.BridgedNode || deviceType.code === DT.PowerSource;
  const primary = endpoint.deviceTypes.find((deviceType) => !isStructural(deviceType)) ?? endpoint.deviceTypes[0];
  return primary ?? null;
}

// Map matter.js device-type names (e.g. "OnOffPlugInUnit") to user-facing labels.
// matter.js gives PascalCase names; we split on case boundaries and special-case
// a few that don't read well naturally.
const DEVICE_TYPE_LABEL_OVERRIDES: Record<number, string> = {
  [DT.OnOffPlugInUnit]: "Outlet",
  [DT.OnOffLight]: "On/Off Light",
  [DT.GenericSwitch]: "Switch",
};

function splitPascalCase(name: string): string {
  return name.replace(/^MA-?/i, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function primaryDeviceTypeName(endpoint: Endpoint): string {
  const primary = primaryDeviceType(endpoint);
  if (!primary) return "Unknown";
  return DEVICE_TYPE_LABEL_OVERRIDES[primary.code] ?? splitPascalCase(primary.name);
}

function hasGenericSwitchChild(children: Endpoint[]): boolean {
  return children.some((child) => child.deviceTypes.some((deviceType) => deviceType.code === DT.GenericSwitch));
}

function hasSensorChild(children: Endpoint[]): boolean {
  return children.some((child) => child.deviceTypes.some((deviceType) => SENSOR_TYPES.has(deviceType.code)));
}

export function categorize(endpoint: Endpoint, children: Endpoint[]): Category {
  const code = primaryDeviceType(endpoint)?.code;
  if (code != null && LIGHT_TYPES.has(code)) return "light";
  if (code === DT.OnOffPlugInUnit) return "outlet";
  if (hasGenericSwitchChild(children)) return "remote";
  // Direct sensor: device type lives on the endpoint itself (e.g. ALPSTUGA).
  if (code != null && SENSOR_TYPES.has(code)) return "sensor";
  // Bridged sensor parent: device type lives on children (e.g. VINDSTYRKA).
  if (hasSensorChild(children)) return "sensor";
  return "other";
}

// For sensor categories: gather a reading from the endpoint itself OR any child
// that has it. Direct sensors (ALPSTUGA) keep readings on the endpoint;
// bridged sensors (VINDSTYRKA) split them across child endpoints.
export function findSelfOrChildWith<K extends keyof Endpoint>(
  endpoint: Endpoint,
  children: Endpoint[],
  key: K,
): Endpoint[K] | null {
  if (endpoint[key] != null) return endpoint[key];
  for (const child of children) {
    if (child[key] != null) return child[key];
  }
  return null;
}

export function iconForCategory(category: Category, endpoint: Endpoint, children: Endpoint[]): List.Item.Props["icon"] {
  const dim = endpoint.reachable === false;
  switch (category) {
    case "light": {
      const hex = endpoint.onOff ? activeColorHex(endpoint) : null;
      const tint = dim ? Color.SecondaryText : (hex ?? (endpoint.onOff ? Color.Yellow : Color.PrimaryText));
      return { source: Icon.LightBulb, tintColor: tint };
    }
    case "outlet":
      return {
        source: Icon.Plug,
        tintColor: dim ? Color.SecondaryText : endpoint.onOff ? Color.Green : Color.PrimaryText,
      };
    case "sensor": {
      const aqi = findSelfOrChildWith(endpoint, children, "airQualityIndex");
      if (aqi != null) {
        return { source: Icon.Wind, tintColor: dim ? Color.SecondaryText : aqiColor(aqi) };
      }
      return { source: Icon.Temperature, tintColor: dim ? Color.SecondaryText : Color.Blue };
    }
    case "remote": {
      const batCritical = endpoint.batteryChargeLevel === 2 || endpoint.batteryReplacementNeeded === true;
      return {
        source: Icon.Mobile,
        tintColor: dim ? Color.SecondaryText : batCritical ? Color.Red : Color.PrimaryText,
      };
    }
    case "other":
      return { source: Icon.QuestionMark, tintColor: Color.SecondaryText };
    default:
      assertNever(category, "unknown category in iconForCategory");
  }
}

export function statusTag(category: Category, endpoint: Endpoint, children: Endpoint[]): List.Item.Accessory | null {
  if (category === "light" || category === "outlet") {
    if (endpoint.onOff == null) return null;
    return {
      tag: {
        value: endpoint.onOff ? "On" : "Off",
        color:
          category === "outlet"
            ? endpoint.onOff
              ? Color.Green
              : Color.SecondaryText
            : endpoint.onOff
              ? Color.Yellow
              : Color.SecondaryText,
      },
    };
  }
  if (category === "sensor") {
    const aqi = findSelfOrChildWith(endpoint, children, "airQualityIndex");
    const label = aqiLabel(aqi);
    if (label) return { tag: { value: label, color: aqiColor(aqi) } };
    return null;
  }
  if (category === "remote" && endpoint.batteryPercent != null) {
    const battery = Math.round(endpoint.batteryPercent);
    return {
      icon: { source: Icon.Battery, tintColor: battery < 20 ? Color.Red : Color.SecondaryText },
      text: `${battery}%`,
    };
  }
  return null;
}

export function fullAccessoriesFor(
  category: Category,
  endpoint: Endpoint,
  children: Endpoint[],
  isToggling: boolean,
): List.Item.Accessory[] {
  const acc: List.Item.Accessory[] = [];

  if (category === "light" || category === "outlet") {
    const tag = statusTag(category, endpoint, children);
    if (tag) acc.push(tag);
    if (category === "light") {
      const lvl = levelPercent(endpoint.currentLevel);
      if (lvl) acc.push({ text: lvl });
      const kelvin = colorTempKelvin(endpoint.colorTemperatureMireds);
      if (kelvin) acc.push({ text: kelvin });
    }
  }

  if (category === "sensor") {
    const tempC = findSelfOrChildWith(endpoint, children, "temperatureCelsius");
    const humid = findSelfOrChildWith(endpoint, children, "humidityPercent");
    const aqi = findSelfOrChildWith(endpoint, children, "airQualityIndex");
    const pm25 = findSelfOrChildWith(endpoint, children, "pm25");
    const tvoc = findSelfOrChildWith(endpoint, children, "tvoc");
    const co2 = findSelfOrChildWith(endpoint, children, "co2");
    if (tempC != null) acc.push({ icon: Icon.Temperature, text: `${tempC.toFixed(1)}°C` });
    if (humid != null) acc.push({ icon: Icon.Raindrop, text: `${humid.toFixed(0)}%` });
    const aqiText = aqiLabel(aqi);
    if (aqiText) acc.push({ tag: { value: aqiText, color: aqiColor(aqi) } });
    const pm25Text = formatConcentration(pm25);
    if (pm25Text) acc.push({ text: { value: `PM2.5 ${pm25Text}` } });
    const co2Text = formatConcentration(co2);
    if (co2Text) acc.push({ text: { value: `CO₂ ${co2Text}` } });
    const tvocText = formatConcentration(tvoc);
    if (tvocText) acc.push({ text: { value: `TVOC ${tvocText}` } });
  }

  if (category === "remote" && endpoint.batteryPercent != null) {
    const battery = Math.round(endpoint.batteryPercent);
    acc.push({
      icon: { source: Icon.Battery, tintColor: battery < 20 ? Color.Red : Color.SecondaryText },
      text: `${battery}%`,
    });
  }

  if (endpoint.reachable === false) {
    acc.push({ icon: { source: Icon.WifiDisabled, tintColor: Color.Red }, tooltip: "Unreachable" });
  }
  if (isToggling) acc.push({ icon: Icon.CircleProgress });

  return acc;
}

export function compactAccessoriesFor(
  category: Category,
  endpoint: Endpoint,
  children: Endpoint[],
  isToggling: boolean,
): List.Item.Accessory[] {
  const acc: List.Item.Accessory[] = [];
  const tag = statusTag(category, endpoint, children);
  if (tag) acc.push(tag);
  if (endpoint.reachable === false) {
    acc.push({ icon: { source: Icon.WifiDisabled, tintColor: Color.Red }, tooltip: "Unreachable" });
  }
  if (isToggling) acc.push({ icon: Icon.CircleProgress });
  return acc;
}

export function categoryLabel(category: Category): string {
  switch (category) {
    case "light":
      return "Lights";
    case "outlet":
      return "Outlets";
    case "sensor":
      return "Sensors";
    case "remote":
      return "Remotes";
    case "other":
      return "Other";
    default:
      assertNever(category, "unknown category in categoryLabel");
  }
}

export const SECTION_ORDER: Category[] = ["light", "outlet", "sensor", "remote", "other"];

export type TopLevelView = {
  endpoint: Endpoint;
  children: Endpoint[];
  category: Category;
};

export function buildView(endpoints: Endpoint[]): TopLevelView[] {
  const aggregator = endpoints.find((endpoint) =>
    endpoint.deviceTypes.some((deviceType) => deviceType.code === DT.Aggregator),
  );
  const aggregatorId = aggregator?.endpointId ?? null;

  const byParent = new Map<number, Endpoint[]>();
  for (const endpoint of endpoints) {
    if (endpoint.parentEndpointId == null) continue;
    const arr = byParent.get(endpoint.parentEndpointId);
    if (arr) arr.push(endpoint);
    else byParent.set(endpoint.parentEndpointId, [endpoint]);
  }

  const topLevel = endpoints.filter(
    (endpoint) => endpoint.parentEndpointId === aggregatorId && endpoint.endpointId !== aggregatorId,
  );

  return topLevel.map((endpoint) => {
    const children = endpoint.endpointId != null ? (byParent.get(endpoint.endpointId) ?? []) : [];
    return { endpoint, children, category: categorize(endpoint, children) };
  });
}

const Metadata = List.Item.Detail.Metadata;

function buildLightOrOutletStateItems(category: "light" | "outlet", endpoint: Endpoint): React.ReactNode[] {
  const items: React.ReactNode[] = [];
  if (endpoint.onOff != null) {
    const onColor = category === "outlet" ? Color.Green : Color.Yellow;
    items.push(
      <Metadata.TagList key="state" title="State">
        <Metadata.TagList.Item
          text={endpoint.onOff ? "On" : "Off"}
          color={endpoint.onOff ? onColor : Color.SecondaryText}
        />
      </Metadata.TagList>,
    );
  }
  if (category !== "light") return items;

  const brightness = levelPercent(endpoint.currentLevel);
  if (brightness) items.push(<Metadata.Label key="brightness" title="Brightness" text={brightness} />);

  const kelvin = colorTempKelvin(endpoint.colorTemperatureMireds);
  if (kelvin) items.push(<Metadata.Label key="ct" title="Color Temperature" text={kelvin} />);

  if (endpoint.colorTemperaturePhysicalMinMireds != null && endpoint.colorTemperaturePhysicalMaxMireds != null) {
    const coolestKelvin = miredsToKelvin(endpoint.colorTemperaturePhysicalMinMireds);
    const warmestKelvin = miredsToKelvin(endpoint.colorTemperaturePhysicalMaxMireds);
    items.push(
      <Metadata.Label key="ctRange" title="Color Temp Range" text={`${warmestKelvin} K – ${coolestKelvin} K`} />,
    );
  }

  const hex = activeColorHex(endpoint);
  if (hex) {
    items.push(
      <Metadata.TagList key="color" title="Color">
        <Metadata.TagList.Item text={hex.toUpperCase()} color={hex} />
      </Metadata.TagList>,
    );
    if (endpoint.currentHue != null)
      items.push(<Metadata.Label key="hue" title="Hue" text={`${matterHueToDegrees(endpoint.currentHue)}°`} />);
    if (endpoint.currentSaturation != null)
      items.push(
        <Metadata.Label
          key="sat"
          title="Saturation"
          text={`${matterSaturationToPercent(endpoint.currentSaturation)}%`}
        />,
      );
  }
  return items;
}

function buildSensorStateItems(endpoint: Endpoint, children: Endpoint[]): React.ReactNode[] {
  const items: React.ReactNode[] = [];
  const aqi = findSelfOrChildWith(endpoint, children, "airQualityIndex");
  const tempC = findSelfOrChildWith(endpoint, children, "temperatureCelsius");
  const humidity = findSelfOrChildWith(endpoint, children, "humidityPercent");

  const aqiText = aqiLabel(aqi);
  if (aqiText) {
    items.push(
      <Metadata.TagList key="aqi" title="Air Quality">
        <Metadata.TagList.Item text={aqiText} color={aqiColor(aqi)} />
      </Metadata.TagList>,
    );
  }
  if (tempC != null) items.push(<Metadata.Label key="temp" title="Temperature" text={`${tempC.toFixed(1)} °C`} />);
  if (humidity != null) items.push(<Metadata.Label key="humid" title="Humidity" text={`${humidity.toFixed(0)} %`} />);

  for (const [key, label] of POLLUTANT_KEYS) {
    const value = findSelfOrChildWith(endpoint, children, key);
    const text = formatConcentration(value);
    if (text) items.push(<Metadata.Label key={key} title={label} text={text} />);
  }
  return items;
}

function buildRemoteStateItems(endpoint: Endpoint): React.ReactNode[] {
  const items: React.ReactNode[] = [];
  if (endpoint.batteryPercent != null) {
    items.push(
      <Metadata.Label
        key="battery"
        title="Battery"
        text={`${Math.round(endpoint.batteryPercent)} %`}
        icon={{
          source: Icon.Battery,
          tintColor: endpoint.batteryPercent < LOW_BATTERY_PERCENT ? Color.Red : Color.SecondaryText,
        }}
      />,
    );
  }
  if (endpoint.batteryChargeLevel != null) {
    const label = BATTERY_CHARGE_LABELS[endpoint.batteryChargeLevel] ?? `Level ${endpoint.batteryChargeLevel}`;
    items.push(
      <Metadata.TagList key="batLevel" title="Charge Level">
        <Metadata.TagList.Item text={label} color={batteryChargeColor(endpoint.batteryChargeLevel)} />
      </Metadata.TagList>,
    );
  }
  if (endpoint.batteryVoltageMillivolts != null) {
    items.push(
      <Metadata.Label key="batV" title="Voltage" text={`${(endpoint.batteryVoltageMillivolts / 1000).toFixed(2)} V`} />,
    );
  }
  if (endpoint.batteryReplacementNeeded === true) {
    items.push(
      <Metadata.TagList key="batReplace" title="Replacement">
        <Metadata.TagList.Item text="Needed" color={Color.Red} />
      </Metadata.TagList>,
    );
  }
  return items;
}

function buildStateSection(category: Category, endpoint: Endpoint, children: Endpoint[]): React.ReactNode[] {
  switch (category) {
    case "light":
    case "outlet":
      return buildLightOrOutletStateItems(category, endpoint);
    case "sensor":
      return buildSensorStateItems(endpoint, children);
    case "remote":
      return buildRemoteStateItems(endpoint);
    case "other":
      return [];
    default:
      assertNever(category, "unknown category in buildStateSection");
  }
}

function buildAboutSection(endpoint: Endpoint): React.ReactNode[] {
  const items: React.ReactNode[] = [];
  if (endpoint.productName) items.push(<Metadata.Label key="product" title="Product" text={endpoint.productName} />);
  if (endpoint.vendorName) items.push(<Metadata.Label key="vendor" title="Vendor" text={endpoint.vendorName} />);
  items.push(<Metadata.Label key="type" title="Type" text={primaryDeviceTypeName(endpoint)} />);
  return items;
}

function buildFirmwareSection(endpoint: Endpoint): React.ReactNode[] {
  const items: React.ReactNode[] = [];
  if (endpoint.softwareVersion)
    items.push(<Metadata.Label key="sw" title="Firmware" text={endpoint.softwareVersion} />);
  if (endpoint.hardwareVersion && endpoint.hardwareVersion !== "1")
    items.push(<Metadata.Label key="hw" title="Hardware" text={endpoint.hardwareVersion} />);
  if (endpoint.serialNumber) items.push(<Metadata.Label key="sn" title="Serial" text={endpoint.serialNumber} />);
  return items;
}

function buildIdSection(endpoint: Endpoint, lastUpdatedAt: number | null | undefined): React.ReactNode[] {
  const items: React.ReactNode[] = [];
  if (endpoint.endpointId != null)
    items.push(<Metadata.Label key="endpoint" title="Endpoint" text={String(endpoint.endpointId)} />);
  if (endpoint.reachable != null)
    items.push(<Metadata.Label key="reach" title="Reachable" text={endpoint.reachable ? "Yes" : "No"} />);
  if (lastUpdatedAt != null)
    items.push(<Metadata.Label key="upd" title="Updated" text={formatRelativeTime(lastUpdatedAt)} />);
  return items;
}

export function renderDetailMetadata(
  category: Category,
  endpoint: Endpoint,
  children: Endpoint[],
  lastUpdatedAt?: number | null,
) {
  const sections = [
    buildStateSection(category, endpoint, children),
    buildAboutSection(endpoint),
    buildFirmwareSection(endpoint),
    buildIdSection(endpoint, lastUpdatedAt),
  ].filter((section) => section.length > 0);

  return (
    <Metadata>
      {sections.map((section, index) => (
        <React.Fragment key={index}>
          {index > 0 && <Metadata.Separator />}
          {section}
        </React.Fragment>
      ))}
    </Metadata>
  );
}

export function DeviceDetail({ nodeId, title }: { nodeId: string; title: string }) {
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [toggling, setToggling] = useState<Set<number>>(new Set());
  const [isShowingDetail, setIsShowingDetail] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const sessionRef = useRef<MatterSession | null>(null);

  useEffect(() => {
    let cancelled = false;
    const session = new MatterSession(nodeId);
    sessionRef.current = session;

    async function loadEndpoints() {
      try {
        await session.ready;
        const result = await session.inspect();
        if (cancelled) return;
        setEndpoints(result);
        setLastUpdatedAt(Date.now());
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setIsLoading(false);
      }
    }

    void loadEndpoints();

    return () => {
      cancelled = true;
      session.close();
    };
  }, [nodeId]);

  useEffect(() => {
    if (error) {
      showToast({ style: Toast.Style.Failure, title: "Failed to inspect device", message: error });
    }
  }, [error]);

  // Tick every 10s so the "Updated Xs ago" line in the detail pane stays current.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (lastUpdatedAt == null) return;
    const id = setInterval(() => setNowTick((tick) => tick + 1), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(id);
  }, [lastUpdatedAt]);

  async function refresh() {
    const session = sessionRef.current;
    if (!session) return;
    try {
      const result = await session.inspect();
      setEndpoints(result);
      setLastUpdatedAt(Date.now());
    } catch (err) {
      showToast({ style: Toast.Style.Failure, title: "Refresh failed", message: (err as Error).message });
    }
  }

  function patchEndpoint(epId: number, updates: Partial<Endpoint>) {
    setEndpoints((endpoints) =>
      endpoints == null
        ? endpoints
        : endpoints.map((endpoint) => (endpoint.endpointId === epId ? { ...endpoint, ...updates } : endpoint)),
    );
  }

  // Common wrapper for any per-endpoint operation. Handles optimistic update,
  // toggling-spinner state, animated toast, success reconcile, and error
  // rollback. Mirrors the runEndpointOp in devices.tsx but scoped to this
  // view's single-node state shape.
  async function runEndpointOp<T>(
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
    const session = sessionRef.current;
    if (!session || endpoint.endpointId == null) return;
    const epId = endpoint.endpointId;

    patchEndpoint(epId, opts.optimistic);
    setToggling((current) => new Set(current).add(epId));
    const toast = await showToast({ style: Toast.Style.Animated, title: opts.title });

    try {
      const result = await opts.run(session);
      if (opts.reconcile) patchEndpoint(epId, opts.reconcile(result));
      toast.style = Toast.Style.Success;
      toast.title = opts.successTitle(result);
    } catch (err) {
      patchEndpoint(epId, opts.rollback);
      toast.style = Toast.Style.Failure;
      toast.title = opts.failTitle;
      toast.message = (err as Error).message;
    } finally {
      setToggling((current) => {
        const next = new Set(current);
        next.delete(epId);
        return next;
      });
    }
  }

  function handleSetOnOff(endpoint: Endpoint, on: boolean) {
    return runEndpointOp(endpoint, {
      title: `Turning ${on ? "on" : "off"}…`,
      successTitle: (result: { onOff: boolean | null }) => ((result.onOff ?? on) ? "Turned on" : "Turned off"),
      failTitle: on ? "Turn on failed" : "Turn off failed",
      optimistic: { onOff: on },
      rollback: { onOff: endpoint.onOff },
      reconcile: (result) => ({ onOff: result.onOff ?? on }),
      run: (session) => session.setOnOff(endpoint.endpointId!, on),
    });
  }

  function handleSetLevel(endpoint: Endpoint, levelMatter: number) {
    const clamped = Math.max(0, Math.min(MATTER_LEVEL_MAX, Math.round(levelMatter)));
    const nextOnOff = clamped > 0;
    const percent = levelToPercentNum(clamped);
    return runEndpointOp(endpoint, {
      title: nextOnOff ? `Setting brightness to ${percent}%…` : "Turning off…",
      successTitle: () => (nextOnOff ? `Brightness ${percent}%` : "Turned off"),
      failTitle: "Brightness change failed",
      optimistic: { currentLevel: clamped, onOff: nextOnOff },
      rollback: { currentLevel: endpoint.currentLevel, onOff: endpoint.onOff },
      run: (session) => session.setLevel(endpoint.endpointId!, clamped),
    });
  }

  function handleSetColor(endpoint: Endpoint, hex: string) {
    const matterColor = hexToMatterColor(hex);
    if (!matterColor) {
      showToast({ style: Toast.Style.Failure, title: "Invalid color", message: `Could not parse ${hex}` });
      return;
    }
    return runEndpointOp(endpoint, {
      title: `Setting color to ${hex.toUpperCase()}…`,
      successTitle: () => `Color ${hex.toUpperCase()}`,
      failTitle: "Color change failed",
      optimistic: { currentHue: matterColor.hue, currentSaturation: matterColor.saturation, colorMode: 0 },
      rollback: {
        currentHue: endpoint.currentHue,
        currentSaturation: endpoint.currentSaturation,
        colorMode: endpoint.colorMode,
      },
      run: (session) => session.setColor(endpoint.endpointId!, matterColor.hue, matterColor.saturation),
    });
  }

  function handleSetColorTemp(endpoint: Endpoint, mireds: number) {
    const { minMireds, maxMireds } = ctRange(endpoint);
    const clampedMireds = Math.max(minMireds, Math.min(maxMireds, Math.round(mireds)));
    const kelvin = miredsToKelvin(clampedMireds);
    return runEndpointOp(endpoint, {
      title: `Setting color temp to ${kelvin} K…`,
      successTitle: () => `Color temp ${kelvin} K`,
      failTitle: "Color temp change failed",
      optimistic: { colorTemperatureMireds: clampedMireds, colorMode: 2 },
      rollback: { colorTemperatureMireds: endpoint.colorTemperatureMireds, colorMode: endpoint.colorMode },
      run: (session) => session.setColorTemp(endpoint.endpointId!, clampedMireds),
    });
  }

  function handleRename(endpoint: Endpoint, label: string) {
    return runEndpointOp(endpoint, {
      title: `Renaming to "${label}"…`,
      successTitle: () => `Renamed to "${label}"`,
      failTitle: "Rename failed",
      optimistic: { nodeLabel: label },
      rollback: { nodeLabel: endpoint.nodeLabel },
      run: (session) => session.setNodeLabel(endpoint.endpointId!, label),
    });
  }

  const views = useMemo(() => buildView(endpoints ?? []), [endpoints]);
  const grouped = useMemo(() => {
    const groups = new Map<Category, TopLevelView[]>();
    for (const view of views) {
      const existing = groups.get(view.category);
      if (existing) existing.push(view);
      else groups.set(view.category, [view]);
    }
    return groups;
  }, [views]);

  const total = views.length;
  const accessoriesFor = isShowingDetail ? compactAccessoriesFor : fullAccessoriesFor;

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={isShowingDetail}
      navigationTitle={title}
      searchBarPlaceholder={`Search ${total} device${total === 1 ? "" : "s"}…`}
    >
      {SECTION_ORDER.map((category) => {
        const items = grouped.get(category) ?? [];
        if (items.length === 0) return null;
        return (
          <List.Section key={category} title={categoryLabel(category)} subtitle={String(items.length)}>
            {items.map(({ endpoint, children }) => {
              // For direct (non-bridged) devices, BridgedDeviceBasicInformation
              // doesn't apply — nodeLabel/productName are null on the endpoint.
              // Fall back to the node-level title we got from `list`.
              const isOnlyEndpoint = views.length === 1;
              const name =
                endpoint.nodeLabel ??
                endpoint.productName ??
                (isOnlyEndpoint ? title : null) ??
                `${primaryDeviceTypeName(endpoint)} ${endpoint.endpointId ?? ""}`.trim();
              const isToggling = endpoint.endpointId != null && toggling.has(endpoint.endpointId);
              const isControllable = category === "light" || category === "outlet" || category === "other";
              const canToggle =
                isControllable && endpoint.onOff != null && endpoint.endpointId != null && endpoint.reachable !== false;

              return (
                <List.Item
                  key={endpoint.endpointId ?? Math.random()}
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
                            onAction={() => handleSetOnOff(endpoint, !endpoint.onOff)}
                          />
                          <Action
                            title={endpoint.onOff ? "Turn On" : "Turn Off"}
                            icon={endpoint.onOff ? Icon.LightBulb : Icon.LightBulbOff}
                            onAction={() => handleSetOnOff(endpoint, !!endpoint.onOff)}
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
                              handleSetLevel(endpoint, stepLevel(endpoint.currentLevel, +BRIGHTNESS_STEP_PERCENT))
                            }
                          />
                          <Action
                            title="Dimmer"
                            icon={Icon.MinusCircle}
                            shortcut={{ modifiers: ["cmd", "shift"], key: "arrowDown" }}
                            onAction={() =>
                              handleSetLevel(endpoint, stepLevel(endpoint.currentLevel, -BRIGHTNESS_STEP_PERCENT))
                            }
                          />
                          <Action.Push
                            title="Set Brightness…"
                            icon={Icon.LightBulb}
                            shortcut={{ modifiers: ["cmd"], key: "b" }}
                            target={
                              <BrightnessForm
                                endpoint={endpoint}
                                onSubmit={(matterLevel) => handleSetLevel(endpoint, matterLevel)}
                              />
                            }
                          />
                          {endpoint.deviceTypes.some((deviceType) => deviceType.code === DT.ExtendedColorLight) && (
                            <Action.Push
                              title="Set Color…"
                              icon={Icon.EyeDropper}
                              shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                              target={
                                <ColorForm endpoint={endpoint} onSubmit={(hex) => handleSetColor(endpoint, hex)} />
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
                                  handleSetColorTemp(endpoint, stepColorTemp(endpoint, -COLOR_TEMP_STEP_KELVIN))
                                }
                              />
                              <Action
                                title="Cooler"
                                icon={Icon.Snowflake}
                                shortcut={{ modifiers: ["cmd", "shift"], key: "arrowLeft" }}
                                onAction={() =>
                                  handleSetColorTemp(endpoint, stepColorTemp(endpoint, +COLOR_TEMP_STEP_KELVIN))
                                }
                              />
                              <Action.Push
                                title="Set Color Temperature…"
                                icon={Icon.Temperature}
                                shortcut={{ modifiers: ["cmd"], key: "t" }}
                                target={
                                  <ColorTempForm
                                    endpoint={endpoint}
                                    onSubmit={(mireds) => handleSetColorTemp(endpoint, mireds)}
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
                      <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={refresh} />
                      {endpoint.endpointId != null && endpoint.reachable !== false && (
                        <Action.Push
                          title="Rename…"
                          icon={Icon.Pencil}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
                          target={
                            <RenameForm endpoint={endpoint} onSubmit={(label) => handleRename(endpoint, label)} />
                          }
                        />
                      )}
                      {endpoint.endpointId != null && (
                        <Action.CopyToClipboard title="Copy Endpoint Id" content={String(endpoint.endpointId)} />
                      )}
                      {endpoint.productName && (
                        <Action.CopyToClipboard title="Copy Product Name" content={endpoint.productName} />
                      )}
                    </ActionPanel>
                  }
                />
              );
            })}
          </List.Section>
        );
      })}
      <List.EmptyView
        icon={Icon.LightBulb}
        title={isLoading ? "Connecting to device…" : error ? "Failed to load" : "No devices"}
        description={
          isLoading
            ? "Establishing a Matter session can take a few seconds."
            : (error ?? "This device exposes no bridged children.")
        }
      />
    </List>
  );
}
