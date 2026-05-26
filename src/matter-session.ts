import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { cliEnv, cliPath, extractRealError } from "./cli";

export type DeviceType = { name: string; code: number };
// A pollutant reading is either a numeric measurement (value + unit) or a
// qualitative level (e.g. Low/Medium/High), or both. The ConcentrationMeasurement
// cluster lets devices implement either or both per feature flag.
export type Concentration = {
  value: number | null;
  unit: number | null;
  level: number | null;
};
export type Endpoint = {
  endpointId: number | null;
  parentEndpointId: number | null;
  deviceTypes: DeviceType[];
  nodeLabel: string | null;
  productName: string | null;
  vendorName: string | null;
  reachable: boolean | null;
  serialNumber: string | null;
  hardwareVersion: string | null;
  softwareVersion: string | null;
  onOff: boolean | null;
  currentLevel: number | null;
  colorTemperatureMireds: number | null;
  colorTemperaturePhysicalMinMireds: number | null;
  colorTemperaturePhysicalMaxMireds: number | null;
  currentHue: number | null;
  currentSaturation: number | null;
  currentX: number | null;
  currentY: number | null;
  colorMode: number | null;
  batteryPercent: number | null;
  batteryChargeLevel: number | null;
  batteryVoltageMillivolts: number | null;
  batteryReplacementNeeded: boolean | null;
  temperatureCelsius: number | null;
  humidityPercent: number | null;
  airQualityIndex: number | null;
  pm25: Concentration | null;
  pm10: Concentration | null;
  pm1: Concentration | null;
  tvoc: Concentration | null;
  co2: Concentration | null;
  co: Concentration | null;
  formaldehyde: Concentration | null;
  no2: Concentration | null;
  ozone: Concentration | null;
  radon: Concentration | null;
};

const SESSION_KILL_GRACE_MS = 1500;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

/**
 * Wraps a long-lived `matter-cli session <nodeId>` child process so callers can
 * issue multiple inspect/toggle requests over one persistent Matter (CASE)
 * session. Avoids the IKEA Dirigera's per-session throttling that hits with
 * one-shot spawns.
 */
export class MatterSession {
  readonly ready: Promise<void>;

  #child: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #stdoutBuffer = "";
  #stderr = "";
  #closed = false;
  #closeError: Error | null = null;
  #resolveReady!: () => void;
  #rejectReady!: (err: Error) => void;

  constructor(nodeId: string) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });

    this.#child = spawn(process.execPath, [cliPath(), "session", nodeId], {
      env: cliEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    this.#child.stderr.on("data", (chunk: string) => (this.#stderr += chunk));
    this.#child.on("error", (err) => this.#fail(err));
    this.#child.on("close", (code) => {
      this.#fail(new Error(extractRealError(this.#stderr, code)));
    });
  }

  inspect(): Promise<Endpoint[]> {
    return this.#request<Endpoint[]>("inspect");
  }

  setOnOff(endpointId: number, on: boolean): Promise<{ endpointId: number; onOff: boolean | null }> {
    return this.#request("setOnOff", { endpointId, on });
  }

  setLevel(endpointId: number, level: number): Promise<{ endpointId: number; currentLevel: number; onOff: boolean }> {
    return this.#request("setLevel", { endpointId, level });
  }

  setColor(
    endpointId: number,
    hue: number,
    saturation: number,
  ): Promise<{ endpointId: number; currentHue: number; currentSaturation: number; colorMode: number }> {
    return this.#request("setColor", { endpointId, hue, saturation });
  }

  setColorTemp(
    endpointId: number,
    mireds: number,
  ): Promise<{ endpointId: number; colorTemperatureMireds: number; colorMode: number }> {
    return this.#request("setColorTemp", { endpointId, mireds });
  }

  setNodeLabel(endpointId: number, label: string): Promise<{ endpointId: number; nodeLabel: string }> {
    return this.#request("setNodeLabel", { endpointId, label });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#child.stdin.end();
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (!this.#child.killed) this.#child.kill();
    }, SESSION_KILL_GRACE_MS);
  }

  #request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closeError ?? new Error("session closed"));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      const line = JSON.stringify({ id, method, ...params }) + "\n";
      try {
        this.#child.stdin.write(line);
      } catch (err) {
        this.#pending.delete(id);
        reject(err as Error);
      }
    });
  }

  #onStdout(chunk: string) {
    this.#stdoutBuffer += chunk;
    let idx;
    while ((idx = this.#stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.#stdoutBuffer.slice(0, idx);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.#handleLine(trimmed);
    }
  }

  #handleLine(line: string) {
    let message: { event?: string; id?: number; result?: unknown; error?: string };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.event === "ready") {
      this.#resolveReady();
      return;
    }
    if (typeof message.id !== "number") return;
    const pendingRequest = this.#pending.get(message.id);
    if (!pendingRequest) return;
    this.#pending.delete(message.id);
    if (message.error) pendingRequest.reject(new Error(message.error));
    else pendingRequest.resolve(message.result);
  }

  #fail(err: Error) {
    if (this.#closeError) return;
    this.#closeError = err;
    this.#closed = true;
    this.#rejectReady(err);
    for (const pendingRequest of this.#pending.values()) pendingRequest.reject(err);
    this.#pending.clear();
  }
}
