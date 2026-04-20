# Pixel Surgeon MCP Server

## Quick Reference
- **Build**: `npm run build` (TypeScript -> dist/)
- **Dev**: `npm run dev` (tsx watch mode)
- **Start**: `npm run start` (run compiled server)
- **Images dir**: `~/Pictures/pixel-surgeon`

## Architecture
MCP server on stdio transport. Single source file: `src/index.ts`.

Google's image gen pipeline ("nanobanana2"):
1. Gemini 3.1 Pro reasons about the prompt (text output)
2. Gemini Flash Image renders the pixels

Flash chokes on text-heavy images. The fix tools exploit this by sending smaller regions.

Video generation uses Veo 3 (async API with polling). Supports 16:9 and 9:16, 5s or 8s duration. Generates both video and ambient audio.

## Tools (9)
- `generate_image` / `generate_images` — text-to-image (single / parallel batch)
- `generate_video` — text-to-video via Veo 3 (async polling, 1-3 min, generates audio)
- `edit_image` — edit existing image with instructions
- `list_images` / `save_image` — file management
- `fix_image` — grid-based tile repair (2x2, 3x3, etc.)
- `fix_region` — targeted region repair (percentage coords, auto aspect ratio snap)
- `interactive_fix` — browser crop UI with multi-shot (1-5 parallel shots, user picks best)

## Style Presets
`generate_image`, `generate_images`, and `edit_image` accept an optional `style` parameter. When set, the preset's prompt prefix is prepended to the user's prompt, and its default aspect ratio is used (unless explicitly overridden).

Current presets:
- **`neo-brutalist`** — Neo-brutalist minimalist magazine editorial. Bold oversized typography, cream/black/terracotta palette, halftone textures, visible grid lines, asymmetric layout. Default aspect ratio: 4:5.
- **`neo-retro-futurism`** — 1960s Space Age optimism meets 1980s arcade aesthetics. Cathode blue, warm amber, salmon red, warm green palette. Scanlines, CRT glow, atomic starbursts, pixel-grid accents, Googie geometry. Default aspect ratio: 4:5.
- **`fractal-arcade`** — Geometric dithered fractal style. No smooth gradients — all shading via dithering, halftone dots, geometric cross-hatch. Sierpinski/hexagonal/diamond fractal backgrounds, low-poly faceted subjects, Amiga/EGA aesthetic. Cathode blue + amber palette. Default aspect ratio: 4:5.

To add a new preset: add an entry to the `STYLE_PRESETS` object in `src/index.ts`, rebuild, and restart.

## Key Patterns
- **Aspect ratio snapping**: `snapToAspectRatio()` — adjusts crop to nearest Gemini ratio, keeps center
- **Histogram matching**: `matchHistogram()` — per-channel RGB linear normalization for seamless compositing
- **Human-in-the-loop**: `interactive_fix` opens browser, awaits POST via Promise, blocks until user submits/selects
- **Held HTTP responses**: `/crop-submit` stays open until Gemini finishes; `/crop-select` awaits user pick

## Environment
- Requires `GOOGLE_API_KEY` env var
- Viewer auto-opens browser on first tool use (random local port)

## When Editing
- After code changes, always run `npm run build` and verify clean compile
- User must restart Claude Desktop/Code to pick up MCP changes
- The `dist/` directory is committed (MCP loads compiled JS directly)
