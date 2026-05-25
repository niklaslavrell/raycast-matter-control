# Matter Control

A [Raycast](https://raycast.com) extension for controlling [Matter](https://csa-iot.org/all-solutions/matter/) smart-home devices on the local network.

## Commands

- **Devices** — browse paired devices, toggle on/off, adjust brightness, color, color temperature, read sensor values.
- **Hubs** — inspect paired Matter nodes (hubs and direct devices), view diagnostics and fabric details, decommission.
- **Pair Device** — commission a new device using its 11- or 21-digit pairing code.

## Tested with

- IKEA DIRIGERA (used as a Matter bridge for Zigbee devices)
- IKEA TRADFRI bulbs (GU10/E14, white-spectrum and color)
- IKEA RODRET dimmer remote
- IKEA TRADFRI smart outlet
- IKEA VINDSTYRKA (bridged via DIRIGERA)
- IKEA ALPSTUGA (direct Matter-over-Thread)

Other spec-compliant Matter devices should work — these are just the ones I run day to day.

## Requirements

- Devices reachable on the same IP network as your Mac, or via a routable IPv6 path (typical for Matter-over-Thread devices behind a Thread Border Router).
- For Thread devices: a Thread Border Router on your network (HomePod, Apple TV, DIRIGERA, etc.).

No cloud account, API key, or router configuration.

## Pairing

1. Put the device into commissioning mode.
2. Run **Pair Device**.
3. Enter the manual code (11 digits) or long code (21 digits) printed on the device.
4. Wait up to a minute. Commissioning runs locally over BLE + Wi-Fi or Thread.

## How it works

Matter operations run in a Node subprocess (`assets/matter-cli.mjs`) that wraps [matter.js](https://github.com/project-chip/matter.js). The subprocess is spawned via `process.execPath` because Raycast's worker can't find a system `node`.

A single long-lived subprocess per command keeps one CASE session warm across multiple operations — DIRIGERA returns `BUSY` if sessions are opened too often.

Storage (fabric keys, paired-node IDs, matter.js state) lives in the extension's Raycast support directory. No data leaves the machine.

## Known limitations

- DIRIGERA throttles too-frequent CASE handshakes; first action after a long idle can be slow.
- Thread devices are unreachable without a Thread Border Router.
- Devices already paired to another Matter ecosystem (Apple Home, Google Home, etc.) need to be *shared* into this fabric via multi-admin, not re-commissioned.
- Matter `Groups` and `Scenes` clusters aren't wired up — devices toggle one at a time.

## Development

```bash
npm install
npm run dev       # builds the CLI and launches Raycast in develop mode
npm run typecheck
npm run lint
```

Build the CLI bundle on its own:

```bash
npm run build:cli
```

`assets/matter-cli.mjs` is committed. Re-run `npm run build:cli` whenever `scripts/matter-cli.ts` changes.

## License

[MIT](LICENSE)

---

"Matter" is a trademark of the [Connectivity Standards Alliance](https://csa-iot.org/). This extension is independent.
