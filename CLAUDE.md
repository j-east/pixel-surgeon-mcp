# Pixel Surgeon MCP Server

## Quick Reference
- **Build**: `npm run build` (TypeScript -> dist/)
- **Dev**: `npm run dev` (tsx watch mode)
- **Start**: `npm run start` (run compiled server)
- **Images dir**: `~/Pictures/pixel-surgeon`

## Architecture
MCP server on stdio transport. Single source file: `src/index.ts`.

Multi-provider image generation via `ImageProvider` interface. Each provider implements `generate()` and `edit()`. Providers are registered at startup based on available API keys.

### Providers
- **Gemini** (`GeminiProvider`) — Google's nanobanana2 pipeline. Gemini 3.1 Flash Image (paid) with auto-fallback to 2.5 Flash Image (free) on billing errors. Supports 9 aspect ratios and 4 image sizes.
- **OpenAI** (`OpenAIProvider`) — GPT Image 1 and GPT Image 2. gpt-image-1 maps to 3 fixed sizes; gpt-image-2 supports flexible resolutions (true 2K/4K at all 9 aspect ratios). Image size param mapped to quality (medium/high). Prefer gpt-image-2 for text-heavy images — it has dramatically better text rendering.

### Adding a new provider
1. Implement `ImageProvider` interface (generate + edit)
2. Add model entry to `MODELS` registry with `provider` field
3. Register in `main()` based on env var availability

Flash chokes on text-heavy images. The fix tools exploit this by sending smaller regions.

Video generation uses Veo 3 (async API with polling, Gemini only). Supports 16:9 and 9:16, 5s or 8s duration. Generates both video and ambient audio.

## Tools (9)
- `generate_image` / `generate_images` — text-to-image (single / parallel batch)
  - `generate_images` applies a single `style` to ALL images in the batch. To generate images in different styles, use separate `generate_image` calls (they can run in parallel).
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
- `GOOGLE_API_KEY` — enables Gemini provider
- `OPENAI_API_KEY` — enables OpenAI provider
- `DEFAULT_IMAGE_MODEL` — optional, sets default model (e.g. `gpt-image-1`). Falls back to `gemini-3.1-flash-image`.
- At least one API key must be set
- Viewer auto-opens browser on first tool use (random local port)

## When Editing
- After code changes, always run `npm run build` and verify clean compile
- User must restart Claude Desktop/Code to pick up MCP changes
- The `dist/` directory is committed (MCP loads compiled JS directly)
