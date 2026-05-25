import { Color } from "@raycast/api";
import { Concentration, Endpoint } from "./matter-session";

// ---- Brightness / LevelControl ----

// LevelControl encodes brightness as 0..254 (matter spec).
export const MATTER_LEVEL_MAX = 254;
const PERCENT_MAX = 100;
export const BRIGHTNESS_STEP_PERCENT = 10;

export function levelToPercentNum(level: number | null): number {
  if (level == null) return 0;
  return Math.round((level / MATTER_LEVEL_MAX) * PERCENT_MAX);
}

export function percentToLevelNum(percent: number): number {
  const clamped = Math.max(0, Math.min(PERCENT_MAX, percent));
  return Math.round((clamped / PERCENT_MAX) * MATTER_LEVEL_MAX);
}

export function levelPercent(level: number | null): string | null {
  if (level == null) return null;
  return `${levelToPercentNum(level)}%`;
}

export function stepLevel(currentLevel: number | null, deltaPercent: number): number {
  const nextPercent = levelToPercentNum(currentLevel) + deltaPercent;
  return percentToLevelNum(nextPercent);
}

// ---- Color temperature ----

const MIREDS_TO_KELVIN = 1_000_000;
const FALLBACK_KELVIN_WHEN_UNKNOWN = 3000;
export const COLOR_TEMP_STEP_KELVIN = 500;

// Fallback range used when the bulb doesn't advertise its limits
// (some Zigbee bridges don't surface them through Matter).
export const DEFAULT_CT_MIN_MIREDS = 153; // ~6500 K
export const DEFAULT_CT_MAX_MIREDS = 500; // 2000 K

export function miredsToKelvin(mireds: number): number {
  return Math.round(MIREDS_TO_KELVIN / mireds);
}

export function kelvinToMireds(kelvin: number): number {
  return Math.round(MIREDS_TO_KELVIN / kelvin);
}

export function colorTempKelvin(mireds: number | null): string | null {
  if (mireds == null || mireds === 0) return null;
  return `${miredsToKelvin(mireds)} K`;
}

export function ctRange(endpoint: Endpoint): { minMireds: number; maxMireds: number } {
  return {
    minMireds: endpoint.colorTemperaturePhysicalMinMireds ?? DEFAULT_CT_MIN_MIREDS,
    maxMireds: endpoint.colorTemperaturePhysicalMaxMireds ?? DEFAULT_CT_MAX_MIREDS,
  };
}

export function stepColorTemp(endpoint: Endpoint, kelvinDelta: number): number {
  const { minMireds, maxMireds } = ctRange(endpoint);
  // Lower mireds = cooler (more blue); higher mireds = warmer (more amber).
  const coolestKelvin = miredsToKelvin(minMireds);
  const warmestKelvin = miredsToKelvin(maxMireds);
  const currentKelvin =
    endpoint.colorTemperatureMireds != null
      ? miredsToKelvin(endpoint.colorTemperatureMireds)
      : FALLBACK_KELVIN_WHEN_UNKNOWN;
  const nextKelvin = Math.max(warmestKelvin, Math.min(coolestKelvin, currentKelvin + kelvinDelta));
  return kelvinToMireds(nextKelvin);
}

// Common color-temperature names; we expose the ones that fall within the
// bulb's physical range as quick presets.
export const CT_PRESETS: { name: string; kelvin: number }[] = [
  { name: "Candle", kelvin: 2000 },
  { name: "Warm White", kelvin: 2700 },
  { name: "Soft White", kelvin: 3000 },
  { name: "Neutral", kelvin: 3500 },
  { name: "Cool White", kelvin: 4000 },
  { name: "Daylight", kelvin: 5000 },
  { name: "Cool Daylight", kelvin: 6500 },
];

export function ctPresetsInRange(endpoint: Endpoint): { name: string; kelvin: number }[] {
  const { minMireds, maxMireds } = ctRange(endpoint);
  const coolestKelvin = miredsToKelvin(minMireds);
  const warmestKelvin = miredsToKelvin(maxMireds);
  return CT_PRESETS.filter((preset) => preset.kelvin >= warmestKelvin && preset.kelvin <= coolestKelvin);
}

// ---- Color (HSV / Hex) ----

const HUE_DEGREES_MAX = 360;
const BYTE_MAX = 255;
const HEX_RADIX = 16;
const COLOR_MODE_HUE_SATURATION = 0;
// Floor for the value channel when converting to hex — keeps dim colored bulbs
// visible in the icon tint instead of looking near-black.
const MIN_HEX_VALUE_FOR_VISIBILITY = 0.3;

// Standard HSV → RGB conversion (https://en.wikipedia.org/wiki/HSL_and_HSV).
// Inputs in 0..1; returns "#RRGGBB".
export function hsvToHex(hue: number, saturation: number, value: number): string {
  const chroma = value * saturation;
  const huePrime = hue * 6;
  const secondary = chroma * (1 - Math.abs((huePrime % 2) - 1));
  let red = 0,
    green = 0,
    blue = 0;
  if (huePrime < 1) [red, green, blue] = [chroma, secondary, 0];
  else if (huePrime < 2) [red, green, blue] = [secondary, chroma, 0];
  else if (huePrime < 3) [red, green, blue] = [0, chroma, secondary];
  else if (huePrime < 4) [red, green, blue] = [0, secondary, chroma];
  else if (huePrime < 5) [red, green, blue] = [secondary, 0, chroma];
  else [red, green, blue] = [chroma, 0, secondary];
  const lightnessOffset = value - chroma;
  const toHexByte = (channel: number) =>
    Math.round((channel + lightnessOffset) * BYTE_MAX)
      .toString(HEX_RADIX)
      .padStart(2, "0");
  return "#" + toHexByte(red) + toHexByte(green) + toHexByte(blue);
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
  const match = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.exec(hex.trim());
  if (!match) return null;
  let sixDigit = match[1];
  if (sixDigit.length === 3) {
    sixDigit = sixDigit[0] + sixDigit[0] + sixDigit[1] + sixDigit[1] + sixDigit[2] + sixDigit[2];
  }
  const red = parseInt(sixDigit.slice(0, 2), HEX_RADIX) / BYTE_MAX;
  const green = parseInt(sixDigit.slice(2, 4), HEX_RADIX) / BYTE_MAX;
  const blue = parseInt(sixDigit.slice(4, 6), HEX_RADIX) / BYTE_MAX;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  let hue = 0;
  if (chroma !== 0) {
    if (max === red) hue = ((green - blue) / chroma) % 6;
    else if (max === green) hue = (blue - red) / chroma + 2;
    else hue = (red - green) / chroma + 4;
  }
  hue = (hue * 60 + HUE_DEGREES_MAX) % HUE_DEGREES_MAX;
  const saturation = max === 0 ? 0 : chroma / max;
  return { h: hue, s: saturation, v: max };
}

export function hexToMatterColor(hex: string): { hue: number; saturation: number } | null {
  const hsv = hexToHsv(hex);
  if (!hsv) return null;
  return {
    hue: Math.round((hsv.h / HUE_DEGREES_MAX) * MATTER_LEVEL_MAX),
    saturation: Math.round(hsv.s * MATTER_LEVEL_MAX),
  };
}

export const COLOR_PRESETS: { name: string; hex: string }[] = [
  { name: "Red", hex: "#FF1A1A" },
  { name: "Coral", hex: "#FF6F4D" },
  { name: "Orange", hex: "#FF8800" },
  { name: "Amber", hex: "#FFB300" },
  { name: "Yellow", hex: "#FFD000" },
  { name: "Lime", hex: "#88FF22" },
  { name: "Mint", hex: "#33FFAA" },
  { name: "Cyan", hex: "#00E0FF" },
  { name: "Sky", hex: "#3399FF" },
  { name: "Ocean", hex: "#0033FF" },
  { name: "Violet", hex: "#8833FF" },
  { name: "Magenta", hex: "#FF33CC" },
  { name: "Pink", hex: "#FF7AA8" },
];

function isInHueSaturationMode(endpoint: Endpoint): boolean {
  return endpoint.colorMode === COLOR_MODE_HUE_SATURATION;
}

// Tint hex for the bulb icon. Null when the bulb isn't currently in
// Hue/Saturation color mode (CT-mode hue/sat attributes are stale).
export function activeColorHex(endpoint: Endpoint): string | null {
  if (!isInHueSaturationMode(endpoint)) return null;
  if (endpoint.currentHue == null || endpoint.currentSaturation == null) return null;
  if (endpoint.currentSaturation === 0) return null;
  const hue = endpoint.currentHue / MATTER_LEVEL_MAX;
  const saturation = endpoint.currentSaturation / MATTER_LEVEL_MAX;
  const value =
    endpoint.currentLevel != null
      ? Math.max(MIN_HEX_VALUE_FOR_VISIBILITY, endpoint.currentLevel / MATTER_LEVEL_MAX)
      : 1;
  return hsvToHex(hue, saturation, value);
}

// Convert Matter's 0..254 hue to degrees for display.
export function matterHueToDegrees(matterHue: number): number {
  return Math.round((matterHue / MATTER_LEVEL_MAX) * HUE_DEGREES_MAX);
}

// Convert Matter's 0..254 saturation to a 0..100 percentage for display.
export function matterSaturationToPercent(matterSaturation: number): number {
  return Math.round((matterSaturation / MATTER_LEVEL_MAX) * PERCENT_MAX);
}

// ---- Concentration measurements ----

// ConcentrationMeasurement.MeasurementUnit enum.
export const UNIT_SUFFIX: Record<number, string> = {
  0: "ppm",
  1: "ppb",
  2: "ppt",
  3: "mg/m³",
  4: "µg/m³",
  5: "ng/m³",
  6: "/m³",
  7: "Bq/m³",
};

// Pollutant Endpoint keys paired with display labels.
export const POLLUTANT_KEYS = [
  ["pm25", "PM2.5"],
  ["pm10", "PM10"],
  ["pm1", "PM1"],
  ["tvoc", "TVOC"],
  ["co2", "CO₂"],
  ["co", "CO"],
  ["formaldehyde", "Formaldehyde"],
  ["no2", "NO₂"],
  ["ozone", "Ozone"],
  ["radon", "Radon"],
] as const;

export function formatConcentration(concentration: Concentration | null): string | null {
  if (!concentration) return null;
  const suffix = concentration.unit != null ? UNIT_SUFFIX[concentration.unit] : null;
  const value = concentration.value;
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return suffix ? `${rounded} ${suffix}` : `${rounded}`;
}

// ---- Air quality index ----

export const AQI_LABELS = ["Unknown", "Good", "Fair", "Moderate", "Poor", "Very Poor", "Extremely Poor"] as const;

export function aqiLabel(index: number | null): string | null {
  if (index == null || index < 0 || index >= AQI_LABELS.length) return null;
  return AQI_LABELS[index];
}

export function aqiColor(index: number | null): Color {
  switch (index) {
    case 1:
    case 2:
      return Color.Green;
    case 3:
      return Color.Yellow;
    case 4:
      return Color.Orange;
    case 5:
      return Color.Red;
    case 6:
      return Color.Magenta;
    default:
      return Color.SecondaryText;
  }
}

// ---- Battery ----

export const LOW_BATTERY_PERCENT = 20;
export const BATTERY_CHARGE_LABELS: Record<number, string> = {
  0: "OK",
  1: "Warning",
  2: "Critical",
};

export function batteryChargeColor(level: number | null): Color {
  switch (level) {
    case 0:
      return Color.Green;
    case 1:
      return Color.Yellow;
    case 2:
      return Color.Red;
    default:
      return Color.SecondaryText;
  }
}

// ---- Time formatting ----

export const RELATIVE_TIME_TICK_MS = 10_000;

export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - ms);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds == null) return "—";
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
