# Themes

Palettes the dashboard paints itself with. Each `*.json` file is one theme; the
file name **is** the theme id (`dark.json` declares `"id": "dark"`), so two
directories can be merged by name without guessing.

| File | Appearance | What it is |
| ---- | ---------- | ---------- |
| `dark.json` | dark | Graphite — the default, and the palette the stylesheet falls back to |
| `light.json` | light | Paper — the daytime palette |

This directory is the **shipped** catalog: it travels with the plugin and is
served by `GET /api/themes`. Put your own palettes in the **user** directory
instead — `themes/` beside the plugin's database
(`$PASEO_HOME/plugins/luck-planner/themes/`), which is the same convention as
`backups/`. A user file with a shipped id replaces the shipped theme, so
`dark.json` next to your database is the way to tweak the default without
touching the plugin.

```json
{
  "id": "sepia",
  "name": "Sepia",
  "appearance": "light",
  "tokens": {
    "bg": "#f4efe6",
    "surface": "#fffaf0",
    "border": "#d9cdb8",
    "text": "#3b3226",
    "textMuted": "#7a6c58",
    "accent": "#8a5a2b",
    "selection": "rgba(138, 90, 43, 0.14)"
  }
}
```

Rules the loader enforces (a file that breaks one is reported, and the other
themes keep working):

- the file name must equal `<id>.json`, and the id is lowercase letters, digits
  and single hyphens;
- `appearance` is `light` or `dark` — it is what "Match Paseo" resolves to;
- all seven tokens are required; they are exactly the colours the stylesheet
  reads. Semantic colours (node kinds, leaf statuses, bee statuses, goals,
  growth, the heat ramp) are **not** themeable: they encode meaning, and a theme
  that recoloured them would change what the diagram says.

Reload the dashboard tab after adding or editing a file — the catalog is read
on each request, so no restart is needed, but the tab fetches it once when it
opens.

The picker lives in the dashboard toolbar: *Match Paseo* follows the appearance
Paseo itself is in (derived from the host's surface colour), then the operating
system. A choice is remembered per device in the tab's local storage.
