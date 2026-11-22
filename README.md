# Power Meter Card

A Lovelace card for a three-phase power meter, built for the Currently One meter over MQTT. It works with any meter that exposes the same kind of sensors.

It shows:

- current power, with export shown in green
- energy used today
- per-phase load (L1–L3) against your main fuse: power, current and voltage
- a 24 h chart of the phases stacked (top edge = total), as 5-minute averages, with a hover tooltip and clickable legend to hide phases
- energy per day for the last 7 days, from long-term statistics, optionally with a line for each day's mean outdoor temperature
- the meter reading and current export

Plain custom element: no build step, no external libraries. Follows your Home Assistant theme and language (Swedish and English).

## Installation

### HACS

1. HACS → ⋮ → **Custom repositories** → add `https://github.com/greberg/power-meter-card`, type **Dashboard**.
2. Search for **Power Meter Card** and install it.
3. Reload the browser.

### Manual

Copy `power-meter-card.js` to `/config/www/` and add `/local/power-meter-card.js` as a dashboard resource (type *JavaScript module*).

## Configuration

```yaml
type: custom:power-meter-card
device: 0123456789ab
fuse: 20
```

`device` is the suffix of the meter's entity IDs, for example `sensor.power_0123456789ab`. When you add the card from the card picker, it is filled in automatically if a meter is found.

| Option | Default | Description |
| --- | --- | --- |
| `device` | – | Entity suffix. Entities default to `sensor.<key>_<device>`. |
| `entities` | – | Override single entities, keyed by `power`, `total`, `returning`, `l1`–`l3`, `i1`–`i3`, `u1`–`u3`. |
| `fuse` | `20` | Main fuse in A, used for the phase load bars. Set to `0` to hide the bars and the fuse chip. |
| `title` | `Power meter` / `Elmätare` | Card title. |
| `icon` | `mdi:meter-electric` | Header icon. |
| `hours_to_show` | `24` | Length of the power chart, in hours. |
| `bucket_minutes` | `5` | Averaging interval for the power chart, in minutes. Lower shows more detail, higher is smoother. |
| `temperature` | – | Temperature sensor, e.g. an outdoor sensor. Adds the daily mean temperature as a line to the energy-per-day chart. Needs long-term statistics (`state_class: measurement`). |
| `days_to_show` | `7` | Number of days in the energy chart (2–31). |
| `show_chart` | `true` | Show the power chart. |
| `show_days` | `true` | Show the energy-per-day chart. |

Units are converted automatically: W/kW for power and Wh/kWh for energy.

### Sensors used

| Key | Meaning |
| --- | --- |
| `power` | Current total power |
| `total` | Meter reading (energy imported, `total_increasing`) |
| `returning` | Current export power |
| `l1`–`l3` | Power per phase |
| `i1`–`i3` | Current per phase |
| `u1`–`u3` | Voltage per phase |

Any missing sensor is skipped. The energy-per-day chart needs `total` to have long-term statistics (`state_class: total_increasing`).

## License

MIT
