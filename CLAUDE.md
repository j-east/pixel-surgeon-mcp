# Nanobanana2 MCP Server

## Quick Reference
- **Build**: `npm run build` (TypeScript -> dist/)
- **Dev**: `npm run dev` (tsx watch mode)
- **Start**: `npm run start` (run compiled server)
- **Images dir**: `~/Pictures/nanobanana2`

## Architecture
MCP server on stdio transport. Single source file: `src/index.ts`.

Google's image gen pipeline ("nanobanana2"):
1. Gemini 3.1 Pro reasons about the prompt (text output)
2. Gemini Flash Image renders the pixels

Flash chokes on text-heavy images. The fix tools exploit this by sending smaller regions.

## Tools (8)
- `generate_image` / `generate_images` — text-to-image (single / parallel batch)
- `edit_image` — edit existing image with instructions
- `list_images` / `save_image` — file management
- `fix_image` — grid-based tile repair (2x2, 3x3, etc.)
- `fix_region` — targeted region repair (percentage coords, auto aspect ratio snap)
- `interactive_fix` — browser crop UI with multi-shot (1-5 parallel shots, user picks best)

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
