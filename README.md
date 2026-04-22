<p align="center">
  <img src="assets/architecture.png" alt="pixel-surgeon-mcp architecture" width="800" />
</p>

<h1 align="center">pixel-surgeon-mcp</h1>

<p align="center">
  <strong>MCP server for AI image &amp; video generation, editing, and transplant-grade region repair</strong><br/>
  Powered by Gemini 3.1 Flash Image, OpenAI GPT Image 2, and Veo 3
</p>

<p align="center">
  <img src="https://img.shields.io/badge/MCP-stdio-blue" alt="MCP stdio" />
  <img src="https://img.shields.io/badge/Gemini_3.1-Flash_Image-4285F4?logo=google" alt="Gemini" />
  <img src="https://img.shields.io/badge/GPT_Image_2-OpenAI-412991?logo=openai&logoColor=white" alt="OpenAI" />
  <img src="https://img.shields.io/badge/Veo_3-Video-34A853?logo=google" alt="Veo 3" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
</p>

---

An [MCP](https://modelcontextprotocol.io) server that gives Claude (or any MCP client) the ability to generate images, edit them, fix garbled text, and create videos — all through natural language.

## How it works

pixel-surgeon-mcp is a **multi-provider** image generation server. You can use either or both providers, and switch between them per-request:

### Gemini (Google)

Google's image generation pipeline uses a two-stage approach: **Gemini 3.1 Pro** reasons about your prompt, then **Gemini 3.1 Flash Image** renders the pixels. Supports 9 aspect ratios at 512/1K/2K/4K resolution.

### OpenAI GPT Image 2

OpenAI's latest image model with dramatically improved text rendering and visual fidelity. Supports flexible resolutions — pixel-surgeon maps your chosen size and aspect ratio to the optimal pixel dimensions automatically. Quality levels: `medium` (fast) and `high` (print-ready). **Excellent for infographics, diagrams, and text-heavy images** where Gemini models struggle.

### Veo 3 (Video)

For video, the server calls **Veo 3** with async polling — generating both video and ambient audio. Supports 16:9 and 9:16 at 5s or 8s duration.

### Region repair

AI image models struggle with text-heavy images. The fix tools solve this by sending smaller regions to the provider, then stitching the results back with histogram-matched compositing for seamless blending.

## Tools

| Tool | Description |
|------|-------------|
| `generate_image` | Text-to-image generation (single image) |
| `generate_images` | Parallel batch generation (1-8 images) |
| `generate_video` | Text-to-video via Veo 3 with audio (5s or 8s) |
| `edit_image` | Edit an existing image with natural language instructions |
| `fix_image` | Grid-based tile repair for garbled text (2x2, 3x3, etc.) |
| `fix_region` | Targeted region repair with automatic aspect ratio snapping |
| `interactive_fix` | Browser-based crop UI with multi-shot selection |
| `list_images` | List generated images and videos |
| `save_image` | Import an external image into the workspace |
| `remove_background` | Remove image background (alpha channel transparency) |

## Models

| Model | Provider | Resolution | Best for |
|-------|----------|-----------|----------|
| `gemini-3.1-flash-image` | Google | 512 / 1K / 2K / 4K | General image generation, photo-realistic scenes |
| `gemini-2.5-flash-image` | Google | 1K max (free tier) | Quick drafts, prototyping |
| `gpt-image-2` | OpenAI | Flexible (up to 4K) | Text-heavy images, infographics, diagrams, typography |
| `gpt-image-1` | OpenAI | 3 fixed sizes | Legacy support |

Force a specific model per-call via the `model` tool parameter, or set `DEFAULT_IMAGE_MODEL` env var.

### Gemini automatic fallback

If a Gemini generation call fails with a billing / prepay error, the server automatically retries on the free-tier **`gemini-2.5-flash-image`** model. The viewer shows a yellow banner when this happens. Free-tier limits: 1K max resolution, 10 RPM, 500 RPD.

## Style presets

All generation and edit tools support an optional `style` parameter:

### `neo-brutalist`
Magazine editorial, bold typography, halftone textures. Cream, black, and terracotta palette.

<img src="assets/style-neo-brutalist.png" alt="neo-brutalist style example" width="400" />

### `neo-retro-futurism`
1960s Space Age meets 1980s arcade. Cathode blue, amber, and salmon palette.

<img src="assets/style-neo-retro-futurism.png" alt="neo-retro-futurism style example" width="400" />

### `fractal-arcade`
Dithered fractals, Sierpinski patterns, low-poly. CRT retro, Amiga/EGA palette.

<img src="assets/style-fractal-arcade.png" alt="fractal-arcade style example" width="400" />

### `clean-tech-infographic`
Technical diagrams, system flows, data pipelines. Dark navy, cyan, and electric blue.

<img src="assets/style-clean-tech-infographic.png" alt="clean-tech-infographic style example" width="600" />

## Setup

### Get your API key(s)

You need at least one provider API key. You can use both for maximum flexibility.

#### Google (Gemini + Veo 3)

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Sign in with your Google account
3. Click **Create API Key** and copy it

> **Prepayment required.** Gemini 3.1 Flash Image and Veo 3 require billing and prepaid credits. The free-tier fallback (2.5 Flash) has limited resolution and rate limits. See [Google AI pricing](https://ai.google.dev/pricing).

#### OpenAI (GPT Image 2)

1. Go to [OpenAI API](https://platform.openai.com/api-keys)
2. Sign in or create an account
3. Click **Create new secret key** and copy it
4. Ensure you have API credits — image generation is billed per request

> GPT Image 2 excels at text rendering, infographics, and diagrams. If you primarily need text-heavy images, this is the provider to use.

### Prerequisites

- Node.js 18+

### Install

```bash
git clone https://github.com/j-east/pixel-surgeon-mcp.git
cd pixel-surgeon-mcp
npm install
npm run build
```

### Configure your MCP client

Add to your Claude Code or Claude Desktop config. Include whichever API keys you have:

```json
{
  "mcpServers": {
    "pixel-surgeon": {
      "command": "node",
      "args": ["/path/to/pixel-surgeon-mcp/dist/index.js"],
      "env": {
        "GOOGLE_API_KEY": "your-google-api-key",
        "OPENAI_API_KEY": "your-openai-api-key"
      }
    }
  }
}
```

Or via the Claude Code CLI:

```bash
claude mcp add pixel-surgeon \
  -e GOOGLE_API_KEY=your-google-key \
  -e OPENAI_API_KEY=your-openai-key \
  -- node /path/to/pixel-surgeon-mcp/dist/index.js
```

### Image output

Generated images are saved to `~/Pictures/pixel-surgeon/`. A local browser viewer auto-launches on first use for full-resolution previews with model selection, respin controls, and search.

## Development

```bash
npm run dev    # tsx watch mode
npm run build  # compile TypeScript
npm run start  # run compiled server
```

## Key implementation details

- **Aspect ratio snapping** — crops are adjusted to the nearest Gemini-supported ratio while preserving center point
- **Histogram matching** — per-channel RGB normalization ensures composited regions blend seamlessly
- **Human-in-the-loop** — `interactive_fix` opens a browser crop UI, blocks via Promise until the user submits, fires parallel Gemini calls, and lets the user pick the best result
- **MCP size limits** — full-resolution images are saved to disk; downsampled versions (< 950KB) are returned in MCP responses

## Contributing

PRs are welcome! We're especially looking for:

### New style presets

Add entries to the `STYLE_PRESETS` object in `src/index.ts`. Your PR should include:

- The preset definition (name, prompt prefix, default aspect ratio)
- 2-3 example images generated with the preset (drop them in your PR description)
- A short description of the visual style for the README table

### Model adapters

The server currently supports Gemini, OpenAI, and Veo 3. We'd love adapters for other image/video generation APIs — Stable Diffusion, Flux, etc. If you're interested in adding one, open an issue first so we can align on the interface.

## Built by Duval Software

pixel-surgeon-mcp is maintained by [John Evans](https://github.com/j-east), part of the engineering team at [Duval Software](https://duvalsoftware.com) — a software engineering firm in Jacksonville Beach, FL building AI-powered tools and custom integrations. If you need MCP servers, AI pipelines, or production tooling built, [get in touch](https://duvalsoftware.com).

## License

MIT
