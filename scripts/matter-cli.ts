#!/usr/bin/env node
// Matter controller CLI used by the Raycast extension.
// Bundled separately from the extension so esbuild's name mangling (which the
// Raycast bundle applies) does not break matter.js.

import "@matter/main/platform";
import { Environment, Logger } from "@matter/main";
import { ManualPairingCodeCodec, NodeId } from "@matter/types";
import { CommissioningController } from "@project-chip/matter.js";
import {
  AdministratorCommissioning,
  AirQuality,
  BasicInformation,
  BridgedDeviceBasicInformation,
  CarbonDioxideConcentrationMeasurement,
  CarbonMonoxideConcentrationMeasurement,
  ColorControl,
  FormaldehydeConcentrationMeasurement,
  GeneralCommissioning,
  GeneralDiagnostics,
  LevelControl,
  NitrogenDioxideConcentrationMeasurement,
  OnOff,
  OperationalCredentials,
  OzoneConcentrationMeasurement,
  Pm1ConcentrationMeasurement,
  Pm10ConcentrationMeasurement,
  Pm25ConcentrationMeasurement,
  PowerSource,
  RadonConcentrationMeasurement,
  RelativeHumidityMeasurement,
  TemperatureMeasurement,
  TotalVolatileOrganicCompoundsConcentrationMeasurement,
} from "@project-chip/matter.js/cluster";
import type { Endpoint } from "@project-chip/matter.js/device";
import type { PairedNode } from "@project-chip/matter.js/device";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

const CONTROLLER_ID = "raycast-matter";

const storagePath = process.env.MATTER_STORAGE_PATH;
if (!storagePath) {
  process.stderr.write("MATTER_STORAGE_PATH must be set\n");
  process.exit(1);
}
mkdirSync(storagePath, { recursive: true });

// Mute matter.js logs entirely. stdout is reserved for JSON I/O and stderr
// for our structured error output — matter.js's warn/info noise corrupts both.
Logger.log = () => {};

const environment = Environment.default;
environment.vars.set("storage.path", storagePath);

function makeController(): CommissioningController {
  return new CommissioningController({
    environment: { environment, id: CONTROLLER_ID },
    // adminFabricLabel is required as of matter.js 0.12 (must be 1–32 chars).
    adminFabricLabel: "Raycast Matter Control",
    autoConnect: false,
  });
}

// matter.js 0.12's controller.close() can hang indefinitely if the mDNS or UDP
// sockets are in a weird state (observed after network interface changes).
// For one-shot subcommands the work is already done by the time we close, so
// fail open after a short wait rather than block the process from exiting.
const CLOSE_TIMEOUT_MS = 3000;
async function closeController(controller: CommissioningController): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      controller.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`controller.close() timed out after ${CLOSE_TIMEOUT_MS}ms`)), CLOSE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// matter.js formats SecureChannel errors as "(generalStatus/protocolStatus) …".
// GeneralStatusCode.Busy = 8 and ProtocolStatusCode.Busy = 4 → "(8/4)".
const BUSY_STATUS_PREFIX = "(8/4)";
const BUSY_RETRY_ATTEMPTS = 3;
const BUSY_RETRY_BASE_DELAY_MS = 800;

function isBusyError(err: unknown): boolean {
  const message = String((err as Error | undefined)?.message ?? err ?? "");
  return message.includes(BUSY_STATUS_PREFIX) || /\bBusy\b/i.test(message);
}

async function withBusyRetry<T>(
  fn: () => Promise<T>,
  { attempts = BUSY_RETRY_ATTEMPTS, baseDelayMs = BUSY_RETRY_BASE_DELAY_MS }: {
    attempts?: number;
    baseDelayMs?: number;
  } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === attempts - 1;
      if (!isBusyError(err) || isLastAttempt) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastErr;
}

function assertNever(value: never, message = "unhandled case"): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

// Cluster clients expose generated attribute getters (getOnOffAttribute, etc.)
// that the static matter.js types don't fully enumerate. We poke them by string
// name; `any` here is the price of dynamic dispatch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClusterClient = any;

async function tryRead<T = unknown>(client: ClusterClient | undefined, attribute: string): Promise<T | null> {
  if (!client) return null;
  const method = client[attribute];
  if (typeof method !== "function") return null;
  try {
    const value = await method.call(client);
    return (value ?? null) as T | null;
  } catch {
    return null;
  }
}

// Bypasses the FabricScoped getter so all paired controllers come back, not
// just our own fabric. eslint-disable: matter.js's typed client doesn't expose
// the raw `attributes` map, so we cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readAllFabrics(creds: any): Promise<unknown> {
  try {
    return (await creds?.attributes.fabrics.get(true, false)) ?? null;
  } catch {
    return null;
  }
}

// A pollutant cluster can expose a numeric measurement, a level enum (Low/
// Medium/High/Critical), or both, depending on the device's feature flags.
// e.g. VINDSTYRKA reports TVOC as level-only (no calibrated ppm number).
type ConcentrationReading = { value: number | null; unit: number | null; level: number | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readConcentration(ep: Endpoint, ClusterDef: any): Promise<ConcentrationReading | null> {
  const cluster = ep.getClusterClient(ClusterDef);
  if (!cluster) return null;
  const [value, unit, level] = await Promise.all([
    tryRead<number>(cluster, "getMeasuredValueAttribute"),
    tryRead<number>(cluster, "getMeasurementUnitAttribute"),
    tryRead<number>(cluster, "getLevelValueAttribute"),
  ]);
  if (value == null && level == null) return null;
  return { value: value ?? null, unit: unit ?? null, level: level ?? null };
}

async function describeEndpoint(ep: Endpoint, parentEndpointId: number | null) {
  const bridged = ep.getClusterClient(BridgedDeviceBasicInformation.Cluster);
  const onOff = ep.getClusterClient(OnOff.Cluster);
  const level = ep.getClusterClient(LevelControl.Cluster);
  const color = ep.getClusterClient(ColorControl.Cluster);
  const power = ep.getClusterClient(PowerSource.Cluster);
  const temp = ep.getClusterClient(TemperatureMeasurement.Cluster);
  const humid = ep.getClusterClient(RelativeHumidityMeasurement.Cluster);
  const airQuality = ep.getClusterClient(AirQuality.Cluster);

  const [
    nodeLabel,
    productName,
    vendorName,
    reachable,
    serialNumber,
    hardwareVersion,
    softwareVersion,
    onOffValue,
    currentLevel,
    colorTemp,
    colorTempPhysicalMin,
    colorTempPhysicalMax,
    currentHue,
    currentSaturation,
    currentX,
    currentY,
    colorMode,
    batPercentRemaining,
    batChargeLevel,
    batVoltage,
    batReplacementNeeded,
    tempCenti,
    humidCenti,
    airQualityIndex,
    pm25,
    pm10,
    pm1,
    tvoc,
    co2,
    co,
    formaldehyde,
    no2,
    ozone,
    radon,
  ] = await Promise.all([
    tryRead<string>(bridged, "getNodeLabelAttribute"),
    tryRead<string>(bridged, "getProductNameAttribute"),
    tryRead<string>(bridged, "getVendorNameAttribute"),
    tryRead<boolean>(bridged, "getReachableAttribute"),
    tryRead<string>(bridged, "getSerialNumberAttribute"),
    tryRead<string>(bridged, "getHardwareVersionStringAttribute"),
    tryRead<string>(bridged, "getSoftwareVersionStringAttribute"),
    tryRead<boolean>(onOff, "getOnOffAttribute"),
    tryRead<number>(level, "getCurrentLevelAttribute"),
    tryRead<number>(color, "getColorTemperatureMiredsAttribute"),
    tryRead<number>(color, "getColorTempPhysicalMinMiredsAttribute"),
    tryRead<number>(color, "getColorTempPhysicalMaxMiredsAttribute"),
    tryRead<number>(color, "getCurrentHueAttribute"),
    tryRead<number>(color, "getCurrentSaturationAttribute"),
    tryRead<number>(color, "getCurrentXAttribute"),
    tryRead<number>(color, "getCurrentYAttribute"),
    tryRead<number>(color, "getColorModeAttribute"),
    tryRead<number>(power, "getBatPercentRemainingAttribute"),
    tryRead<number>(power, "getBatChargeLevelAttribute"),
    tryRead<number>(power, "getBatVoltageAttribute"),
    tryRead<boolean>(power, "getBatReplacementNeededAttribute"),
    tryRead<number>(temp, "getMeasuredValueAttribute"),
    tryRead<number>(humid, "getMeasuredValueAttribute"),
    tryRead<number>(airQuality, "getAirQualityAttribute"),
    readConcentration(ep, Pm25ConcentrationMeasurement.Cluster),
    readConcentration(ep, Pm10ConcentrationMeasurement.Cluster),
    readConcentration(ep, Pm1ConcentrationMeasurement.Cluster),
    readConcentration(ep, TotalVolatileOrganicCompoundsConcentrationMeasurement.Cluster),
    readConcentration(ep, CarbonDioxideConcentrationMeasurement.Cluster),
    readConcentration(ep, CarbonMonoxideConcentrationMeasurement.Cluster),
    readConcentration(ep, FormaldehydeConcentrationMeasurement.Cluster),
    readConcentration(ep, NitrogenDioxideConcentrationMeasurement.Cluster),
    readConcentration(ep, OzoneConcentrationMeasurement.Cluster),
    readConcentration(ep, RadonConcentrationMeasurement.Cluster),
  ]);

  return {
    endpointId: ep.number ?? null,
    parentEndpointId,
    deviceTypes: ep
      .getDeviceTypes()
      .map((deviceType) => ({ name: deviceType.name, code: Number(deviceType.code) })),
    nodeLabel,
    productName,
    vendorName,
    reachable,
    serialNumber,
    hardwareVersion,
    softwareVersion,
    onOff: onOffValue,
    currentLevel,
    colorTemperatureMireds: colorTemp,
    colorTemperaturePhysicalMinMireds: colorTempPhysicalMin ?? null,
    colorTemperaturePhysicalMaxMireds: colorTempPhysicalMax ?? null,
    currentHue,
    currentSaturation,
    currentX,
    currentY,
    colorMode: colorMode ?? null,
    // PowerSource.batPercentRemaining is reported as half-percent (0..200).
    batteryPercent: batPercentRemaining == null ? null : batPercentRemaining / 2,
    batteryChargeLevel: batChargeLevel ?? null,
    batteryVoltageMillivolts: batVoltage ?? null,
    batteryReplacementNeeded: batReplacementNeeded ?? null,
    // Measurement clusters report values in 1/100 of the unit.
    temperatureCelsius: tempCenti == null ? null : tempCenti / 100,
    humidityPercent: humidCenti == null ? null : humidCenti / 100,
    airQualityIndex: airQualityIndex ?? null,
    pm25,
    pm10,
    pm1,
    tvoc,
    co2,
    co,
    formaldehyde,
    no2,
    ozone,
    radon,
  };
}

type EndpointSnapshot = Awaited<ReturnType<typeof describeEndpoint>>;

async function collectEndpoints(pairedNode: PairedNode): Promise<EndpointSnapshot[]> {
  // BridgedDeviceBasicInformation carries per-device label/product/vendor on
  // bridged children (e.g. TRADFRI bulbs behind DIRIGERA). Direct Matter
  // devices (e.g. ALPSTUGA) only expose BasicInformation on the root, so for
  // their child endpoints we surface the root's values as the display fallback.
  // Without this, a directly-paired sensor's user-given nodeLabel never shows.
  const rootBasic = pairedNode.getRootClusterClient(BasicInformation.Cluster);
  const [rootNodeLabel, rootProductName, rootVendorName] = await Promise.all([
    tryRead<string>(rootBasic, "getNodeLabelAttribute"),
    tryRead<string>(rootBasic, "getProductNameAttribute"),
    tryRead<string>(rootBasic, "getVendorNameAttribute"),
  ]);

  const result: EndpointSnapshot[] = [];
  async function visit(ep: Endpoint, parentEndpointId: number | null): Promise<void> {
    const description = await describeEndpoint(ep, parentEndpointId);
    if (ep.getClusterClient(BridgedDeviceBasicInformation.Cluster) == null) {
      description.nodeLabel ??= rootNodeLabel;
      description.productName ??= rootProductName;
      description.vendorName ??= rootVendorName;
    }
    result.push(description);
    for (const child of ep.getChildEndpoints()) {
      await visit(child, ep.number ?? null);
    }
  }
  for (const ep of pairedNode.getDevices() as Endpoint[]) {
    await visit(ep, null);
  }
  return result;
}

const MAX_NODE_LABEL_BYTES = 32;

async function setEndpointNodeLabel(pairedNode: PairedNode, endpointId: number, label: string) {
  if (new TextEncoder().encode(label).length > MAX_NODE_LABEL_BYTES) {
    throw new Error(`label is longer than ${MAX_NODE_LABEL_BYTES} UTF-8 bytes`);
  }
  const endpoint = pairedNode.getDeviceById(endpointId);
  if (!endpoint) throw new Error(`endpoint ${endpointId} not found`);
  // Bridged child endpoints (e.g. TRADFRI bulbs behind a DIRIGERA) carry their
  // own BridgedDeviceBasicInformation. Direct devices (e.g. ALPSTUGA) only
  // expose BasicInformation on the root endpoint, so fall back to that.
  const bridged = endpoint.getClusterClient(BridgedDeviceBasicInformation.Cluster);
  if (bridged) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bridged as any).setNodeLabelAttribute(label);
    return { endpointId, nodeLabel: label };
  }
  const basic = pairedNode.getRootClusterClient(BasicInformation.Cluster);
  if (basic) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (basic as any).setNodeLabelAttribute(label);
    return { endpointId, nodeLabel: label };
  }
  throw new Error(`endpoint ${endpointId} does not expose a writable nodeLabel`);
}

async function setEndpointOnOff(pairedNode: PairedNode, endpointId: number, on: boolean) {
  const endpoint = pairedNode.getDeviceById(endpointId);
  if (!endpoint) throw new Error(`endpoint ${endpointId} not found`);
  const onOff = endpoint.getClusterClient(OnOff.Cluster);
  if (!onOff) throw new Error(`endpoint ${endpointId} does not support OnOff cluster`);
  if (on) await onOff.on();
  else await onOff.off();
  // Don't read back: the Dirigera ACKs Matter commands before its Zigbee-side
  // attribute cache updates, so an immediate read returns the previous value.
  // Since we used an explicit on/off command (not toggle), the user's intent
  // *is* the resulting state — return it directly.
  return { endpointId, onOff: on };
}

async function setEndpointColorTemp(pairedNode: PairedNode, endpointId: number, mireds: number) {
  if (!Number.isFinite(mireds)) throw new Error(`invalid mireds: ${mireds}`);
  const endpoint = pairedNode.getDeviceById(endpointId);
  if (!endpoint) throw new Error(`endpoint ${endpointId} not found`);
  const colorClient = endpoint.getClusterClient(ColorControl.Cluster);
  if (!colorClient) throw new Error(`endpoint ${endpointId} does not support ColorControl`);
  const clampedMireds = Math.max(1, Math.round(mireds));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (colorClient as any).moveToColorTemperature({
    colorTemperatureMireds: clampedMireds,
    transitionTime: 0,
    optionsMask: {},
    optionsOverride: {},
  });
  // Switches the bulb's colorMode to 2 (ColorTemperatureMireds).
  return { endpointId, colorTemperatureMireds: clampedMireds, colorMode: 2 };
}

async function setEndpointColor(
  pairedNode: PairedNode,
  endpointId: number,
  hue: number,
  saturation: number,
) {
  if (!Number.isFinite(hue) || !Number.isFinite(saturation)) {
    throw new Error(`invalid hue/saturation: ${hue}/${saturation}`);
  }
  const clampedHue = Math.max(0, Math.min(254, Math.round(hue)));
  const clampedSaturation = Math.max(0, Math.min(254, Math.round(saturation)));
  const endpoint = pairedNode.getDeviceById(endpointId);
  if (!endpoint) throw new Error(`endpoint ${endpointId} not found`);
  const colorClient = endpoint.getClusterClient(ColorControl.Cluster);
  if (!colorClient) throw new Error(`endpoint ${endpointId} does not support ColorControl`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (colorClient as any).moveToHueAndSaturation({
    hue: clampedHue,
    saturation: clampedSaturation,
    transitionTime: 0,
    optionsMask: {},
    optionsOverride: {},
  });
  return {
    endpointId,
    currentHue: clampedHue,
    currentSaturation: clampedSaturation,
    colorMode: 0,
  };
}

async function setEndpointLevel(pairedNode: PairedNode, endpointId: number, level: number) {
  if (!Number.isFinite(level)) throw new Error(`invalid level: ${level}`);
  const clamped = Math.max(0, Math.min(254, Math.round(level)));
  const endpoint = pairedNode.getDeviceById(endpointId);
  if (!endpoint) throw new Error(`endpoint ${endpointId} not found`);
  // Level 0 means "off". The IKEA Dirigera rejects moveToLevelWithOnOff(level=0)
  // with a FAILURE status, so route through OnOff.off() instead.
  if (clamped === 0) {
    const onOff = endpoint.getClusterClient(OnOff.Cluster);
    if (!onOff) throw new Error(`endpoint ${endpointId} does not support OnOff cluster`);
    await onOff.off();
    return { endpointId, currentLevel: 0, onOff: false };
  }
  const levelClient = endpoint.getClusterClient(LevelControl.Cluster);
  if (!levelClient) throw new Error(`endpoint ${endpointId} does not support LevelControl`);
  // moveToLevelWithOnOff also turns the OnOff state on if the bulb was off,
  // so raising brightness from 0 brings the bulb back on. transitionTime is in
  // tenths of a second; 0 = instant.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (levelClient as any).moveToLevelWithOnOff({
    level: clamped,
    transitionTime: 0,
    optionsMask: {},
    optionsOverride: {},
  });
  return { endpointId, currentLevel: clamped, onOff: true };
}

async function listDevices() {
  const controller = makeController();
  await controller.start();
  try {
    return controller.getCommissionedNodesDetails().map((details) => ({
      nodeId: details.nodeId.toString(),
      operationalAddress: details.operationalAddress ?? null,
      advertisedName: details.advertisedName ?? null,
      productName: details.deviceData?.basicInformation?.productName ?? null,
      vendorName: details.deviceData?.basicInformation?.vendorName ?? null,
    }));
  } finally {
    await closeController(controller);
  }
}

async function inspectNode(nodeIdStr: string): Promise<EndpointSnapshot[]> {
  const controller = makeController();
  await controller.start();
  try {
    const pairedNode = await controller.connectNode(NodeId(BigInt(nodeIdStr)));
    return await collectEndpoints(pairedNode);
  } finally {
    await closeController(controller);
  }
}

async function getHubInfo(nodeIdStr: string) {
  const controller = makeController();
  await controller.start();
  try {
    const pairedNode = await controller.connectNode(NodeId(BigInt(nodeIdStr)));
    const basic = pairedNode.getRootClusterClient(BasicInformation.Cluster);
    const diag = pairedNode.getRootClusterClient(GeneralDiagnostics.Cluster);
    const creds = pairedNode.getRootClusterClient(OperationalCredentials.Cluster);
    const adminComm = pairedNode.getRootClusterClient(AdministratorCommissioning.Cluster);

    const [
      vendorName,
      productName,
      productLabel,
      nodeLabel,
      hardwareVersion,
      softwareVersion,
      serialNumber,
      uniqueId,
      manufacturingDate,
      partNumber,
      productUrl,
      reachable,
      upTime,
      totalOperationalHours,
      rebootCount,
      bootReason,
      fabrics,
      windowStatus,
      adminVendorId,
      adminFabricIndex,
    ] = await Promise.all([
      tryRead<string>(basic, "getVendorNameAttribute"),
      tryRead<string>(basic, "getProductNameAttribute"),
      tryRead<string>(basic, "getProductLabelAttribute"),
      tryRead<string>(basic, "getNodeLabelAttribute"),
      tryRead<string>(basic, "getHardwareVersionStringAttribute"),
      tryRead<string>(basic, "getSoftwareVersionStringAttribute"),
      tryRead<string>(basic, "getSerialNumberAttribute"),
      tryRead<string>(basic, "getUniqueIdAttribute"),
      tryRead<string>(basic, "getManufacturingDateAttribute"),
      tryRead<string>(basic, "getPartNumberAttribute"),
      tryRead<string>(basic, "getProductUrlAttribute"),
      tryRead<boolean>(basic, "getReachableAttribute"),
      tryRead<number | bigint>(diag, "getUpTimeAttribute"),
      tryRead<number>(diag, "getTotalOperationalHoursAttribute"),
      tryRead<number>(diag, "getRebootCountAttribute"),
      tryRead<number>(diag, "getBootReasonAttribute"),
      // Bypass tryRead/getter: fabrics is FabricScoped — the generated getter
      // returns only our own fabric. Read directly with isFabricFiltered=false
      // to see ALL controllers paired to this device (Apple Home, Google Home, etc).
      readAllFabrics(creds),
      tryRead<number>(adminComm, "getWindowStatusAttribute"),
      tryRead<number>(adminComm, "getAdminVendorIdAttribute"),
      tryRead<number>(adminComm, "getAdminFabricIndexAttribute"),
    ]);

    const endpoints = await collectEndpoints(pairedNode);

    type FabricDescriptor = {
      fabricIndex?: number;
      fabricId?: bigint | number;
      nodeId?: bigint | number;
      vendorId?: number;
      label?: string;
    };

    return {
      basicInformation: {
        vendorName,
        productName,
        productLabel,
        nodeLabel,
        hardwareVersion,
        softwareVersion,
        serialNumber,
        uniqueId,
        manufacturingDate,
        partNumber,
        productUrl,
        reachable,
      },
      diagnostics: {
        // upTime can be a BigInt for high values; coerce to Number for JSON.
        upTimeSeconds: upTime == null ? null : Number(upTime),
        totalOperationalHours: totalOperationalHours ?? null,
        rebootCount: rebootCount ?? null,
        bootReason: bootReason ?? null,
      },
      fabrics: Array.isArray(fabrics)
        ? (fabrics as FabricDescriptor[]).map((fabric) => ({
            fabricIndex: fabric.fabricIndex ?? null,
            fabricId: fabric.fabricId == null ? null : String(fabric.fabricId),
            nodeId: fabric.nodeId == null ? null : String(fabric.nodeId),
            vendorId: fabric.vendorId == null ? null : Number(fabric.vendorId),
            label: fabric.label ?? null,
          }))
        : [],
      commissioning: {
        // 0 = WindowNotOpen, 1 = EnhancedWindowOpen, 2 = BasicWindowOpen.
        windowStatus: windowStatus ?? null,
        adminVendorId: adminVendorId == null ? null : Number(adminVendorId),
        adminFabricIndex: adminFabricIndex ?? null,
      },
      endpoints,
    };
  } finally {
    await closeController(controller);
  }
}

async function decommissionDevice(nodeIdStr: string) {
  const controller = makeController();
  await controller.start();
  try {
    // removeNode tries decommission first; if the device is unreachable it
    // still removes the node from the controller's local storage. That's
    // friendlier than failing when the device is offline or already wiped.
    await controller.removeNode(NodeId(BigInt(nodeIdStr)), true);
    return { nodeId: nodeIdStr };
  } finally {
    await closeController(controller);
  }
}

async function pairDevice(code: string) {
  const decoded = ManualPairingCodeCodec.decode(code);
  const controller = makeController();
  await controller.start();
  try {
    const nodeId = await controller.commissionNode({
      commissioning: {
        regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
        regulatoryCountryCode: "XX",
      },
      discovery: { identifierData: { shortDiscriminator: decoded.shortDiscriminator } },
      passcode: decoded.passcode,
    });
    return { nodeId: nodeId.toString() };
  } finally {
    await closeController(controller);
  }
}

type SessionRequest =
  | { id: number; method: "inspect" }
  | { id: number; method: "setOnOff"; endpointId: number; on: boolean }
  | { id: number; method: "setLevel"; endpointId: number; level: number }
  | { id: number; method: "setColor"; endpointId: number; hue: number; saturation: number }
  | { id: number; method: "setColorTemp"; endpointId: number; mireds: number }
  | { id: number; method: "setNodeLabel"; endpointId: number; label: string };

async function runSessionRequest(req: SessionRequest, pairedNode: PairedNode): Promise<unknown> {
  switch (req.method) {
    case "inspect":
      return collectEndpoints(pairedNode);
    case "setOnOff":
      return setEndpointOnOff(pairedNode, Number(req.endpointId), Boolean(req.on));
    case "setLevel":
      return setEndpointLevel(pairedNode, Number(req.endpointId), Number(req.level));
    case "setColor":
      return setEndpointColor(pairedNode, Number(req.endpointId), Number(req.hue), Number(req.saturation));
    case "setColorTemp":
      return setEndpointColorTemp(pairedNode, Number(req.endpointId), Number(req.mireds));
    case "setNodeLabel":
      return setEndpointNodeLabel(pairedNode, Number(req.endpointId), String(req.label));
    default:
      assertNever(req, "unknown session method");
  }
}

async function handleSessionLine(
  line: string,
  pairedNode: PairedNode,
  emit: (obj: unknown) => void,
): Promise<void> {
  let req: SessionRequest;
  try {
    req = JSON.parse(line) as SessionRequest;
  } catch (err) {
    emit({ error: `invalid JSON: ${(err as Error).message}` });
    return;
  }
  try {
    const result = await runSessionRequest(req, pairedNode);
    emit({ id: req.id, result });
  } catch (err) {
    emit({ id: req.id, error: String((err as Error)?.message ?? err) });
  }
}

// Long-lived session mode: holds one Matter session open and dispatches
// newline-delimited JSON-RPC requests from stdin. Avoids per-operation
// CASE re-handshake (which the IKEA Dirigera throttles with Busy responses).
async function runSession(nodeIdStr: string): Promise<void> {
  function emit(obj: unknown): void {
    process.stdout.write(JSON.stringify(obj) + "\n");
  }

  const controller = makeController();
  await controller.start();
  let pairedNode: PairedNode;
  try {
    pairedNode = await withBusyRetry(() => controller.connectNode(NodeId(BigInt(nodeIdStr))));
  } catch (err) {
    await closeController(controller);
    throw err;
  }
  emit({ event: "ready" });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending: Promise<void> = Promise.resolve();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    pending = pending.then(() => handleSessionLine(trimmed, pairedNode, emit));
  });

  await new Promise<void>((resolve) => rl.on("close", () => resolve()));
  await pending.catch(() => {});
  await closeController(controller);
}

async function main(): Promise<void> {
  const [, , subcommand, ...args] = process.argv;
  switch (subcommand) {
    case "list": {
      const result = await listDevices();
      process.stdout.write(JSON.stringify(result));
      return;
    }
    case "pair": {
      const code = args[0];
      if (!code) throw new Error("usage: matter-cli pair <pairing-code>");
      const result = await pairDevice(code);
      process.stdout.write(JSON.stringify(result));
      return;
    }
    case "hub-info": {
      const nodeIdStr = args[0];
      if (!nodeIdStr) throw new Error("usage: matter-cli hub-info <nodeId>");
      const result = await getHubInfo(nodeIdStr);
      process.stdout.write(JSON.stringify(result));
      return;
    }
    case "decommission": {
      const nodeIdStr = args[0];
      if (!nodeIdStr) throw new Error("usage: matter-cli decommission <nodeId>");
      const result = await decommissionDevice(nodeIdStr);
      process.stdout.write(JSON.stringify(result));
      return;
    }
    case "inspect": {
      const nodeIdStr = args[0];
      if (!nodeIdStr) throw new Error("usage: matter-cli inspect <nodeId>");
      const result = await inspectNode(nodeIdStr);
      process.stdout.write(JSON.stringify(result));
      return;
    }
    case "session": {
      const nodeIdStr = args[0];
      if (!nodeIdStr) throw new Error("usage: matter-cli session <nodeId>");
      await runSession(nodeIdStr);
      return;
    }
    default:
      throw new Error(`unknown subcommand: ${subcommand ?? "(none)"}`);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    const error = err as Error & { cause?: Error };
    process.stderr.write(String(error?.stack ?? error) + "\n");
    // Unwrap matter.js's CrashedDependencyError to surface the real cause.
    let cause = error?.cause;
    while (cause) {
      process.stderr.write("Caused by: " + String(cause?.stack ?? cause) + "\n");
      cause = (cause as Error & { cause?: Error })?.cause;
    }
    process.exit(1);
  },
);
