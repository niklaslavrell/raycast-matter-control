import { Action, ActionPanel, Form, Icon, useNavigation } from "@raycast/api";
import { useState } from "react";
import { Endpoint } from "./matter-session";
import {
  COLOR_PRESETS,
  activeColorHex,
  ctPresetsInRange,
  ctRange,
  hexToMatterColor,
  kelvinToMireds,
  levelToPercentNum,
  miredsToKelvin,
  percentToLevelNum,
} from "./format";

const FALLBACK_KELVIN_WHEN_UNKNOWN = 3000;

function lampDisplayName(endpoint: Endpoint): string {
  return endpoint.nodeLabel ?? endpoint.productName ?? "Lamp";
}

export function BrightnessForm({
  endpoint,
  onSubmit,
}: {
  endpoint: Endpoint;
  onSubmit: (matterLevel: number) => void;
}) {
  const { pop } = useNavigation();
  const initialPercent = levelToPercentNum(endpoint.currentLevel ?? null);
  const [error, setError] = useState<string | undefined>();

  function submit(values: { brightness: string }) {
    const parsed = Number(values.brightness.trim());
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      setError("Enter a value between 0 and 100");
      return;
    }
    onSubmit(percentToLevelNum(parsed));
    pop();
  }

  return (
    <Form
      navigationTitle={`Brightness: ${lampDisplayName(endpoint)}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Set Brightness" icon={Icon.LightBulb} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="brightness"
        title="Brightness"
        placeholder="0–100"
        defaultValue={String(initialPercent)}
        info="0 turns the lamp off."
        error={error}
        onChange={() => error && setError(undefined)}
        autoFocus
      />
    </Form>
  );
}

export function ColorForm({ endpoint, onSubmit }: { endpoint: Endpoint; onSubmit: (hex: string) => void }) {
  const { pop } = useNavigation();
  const initial = activeColorHex(endpoint) ?? "#FFFFFF";
  const [error, setError] = useState<string | undefined>();

  function submitHex(hex: string) {
    if (!hexToMatterColor(hex)) {
      setError("Enter a hex color like #FF8800");
      return;
    }
    onSubmit(hex);
    pop();
  }

  return (
    <Form
      navigationTitle={`Color: ${lampDisplayName(endpoint)}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Set Color"
            icon={Icon.EyeDropper}
            onSubmit={(values: { hex: string }) => submitHex(values.hex)}
          />
          <ActionPanel.Section title="Presets">
            {COLOR_PRESETS.map((preset) => (
              <Action
                key={preset.hex}
                title={preset.name}
                icon={{ source: Icon.CircleFilled, tintColor: preset.hex }}
                onAction={() => submitHex(preset.hex)}
              />
            ))}
          </ActionPanel.Section>
        </ActionPanel>
      }
    >
      <Form.TextField
        id="hex"
        title="Hex Color"
        placeholder="#FF8800"
        defaultValue={initial.toUpperCase()}
        info="Or pick a preset from the actions menu (Cmd+K)."
        error={error}
        onChange={() => error && setError(undefined)}
        autoFocus
      />
      <Form.Description text="Tip: Cmd+K opens the actions menu with named presets." />
    </Form>
  );
}

export function ColorTempForm({ endpoint, onSubmit }: { endpoint: Endpoint; onSubmit: (mireds: number) => void }) {
  const { pop } = useNavigation();
  const { minMireds, maxMireds } = ctRange(endpoint);
  const coolestKelvin = miredsToKelvin(minMireds);
  const warmestKelvin = miredsToKelvin(maxMireds);
  const initialKelvin =
    endpoint.colorTemperatureMireds != null
      ? miredsToKelvin(endpoint.colorTemperatureMireds)
      : FALLBACK_KELVIN_WHEN_UNKNOWN;
  const presets = ctPresetsInRange(endpoint);
  const [error, setError] = useState<string | undefined>();

  function submitKelvin(kelvin: number) {
    if (!Number.isFinite(kelvin) || kelvin < warmestKelvin || kelvin > coolestKelvin) {
      setError(`Enter a value between ${warmestKelvin} K and ${coolestKelvin} K`);
      return;
    }
    onSubmit(kelvinToMireds(kelvin));
    pop();
  }

  return (
    <Form
      navigationTitle={`Color Temperature: ${lampDisplayName(endpoint)}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Set Color Temperature"
            icon={Icon.Temperature}
            onSubmit={(values: { kelvin: string }) => submitKelvin(Number(values.kelvin.trim()))}
          />
          {presets.length > 0 && (
            <ActionPanel.Section title="Presets">
              {presets.map((preset) => (
                <Action
                  key={preset.kelvin}
                  title={`${preset.name} (${preset.kelvin} K)`}
                  icon={Icon.Sun}
                  onAction={() => submitKelvin(preset.kelvin)}
                />
              ))}
            </ActionPanel.Section>
          )}
        </ActionPanel>
      }
    >
      <Form.TextField
        id="kelvin"
        title="Kelvin"
        placeholder={`${warmestKelvin}–${coolestKelvin}`}
        defaultValue={String(initialKelvin)}
        info={`This bulb supports ${warmestKelvin} K (warm) to ${coolestKelvin} K (cool).`}
        error={error}
        onChange={() => error && setError(undefined)}
        autoFocus
      />
      <Form.Description text="Tip: Cmd+K opens the actions menu with named presets." />
    </Form>
  );
}
