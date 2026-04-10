# AI Image Generation Has a Text Problem. Here's How I Fixed It.

Google's image generation AI understands exactly what you want. It just can't always draw it.

## The Gap Between Understanding and Rendering

When you ask Google's Gemini to generate an image with text — a system diagram, an infographic, a branded asset — something interesting happens behind the scenes. The request hits Gemini 3.1 Pro first, which *thinks* about your prompt, plans the layout, and even outputs confirmations like:

> "I have updated the infographic to fix the typo as requested. The text under the 'Optional Enhancement' section now correctly reads 'Adds natural voice conversation.'"

Pro gets it. It understands your intent perfectly. Then it hands off to the Flash Image model to actually render the pixels.

And that's where things fall apart.

## The Renderer Chokes on Text

Flash Image is fast and capable, but it has a hard limit on how much text it can render reliably in a single pass. Push past that limit — which isn't hard with any real-world infographic, diagram, or data-dense image — and you get garbled characters, merged words, phantom letters. The model *knows* what the text should say (Pro told it), but it can't draw it all at once.

This isn't a prompt engineering problem. You can't fix it by being more specific. The smart model already understood you perfectly. The renderer just ran out of bandwidth.

## Surgical Region Repair

The fix turned out to be surprisingly simple in concept: don't ask the renderer to fix the whole image. Just fix the broken part.

I built a tool that:

1. **Opens the image in a browser-based crop UI** — you draw a rectangle around the problem area
2. **Snaps the selection to a clean aspect ratio** — the renderer needs standard ratios (16:9, 3:2, etc.) to produce output that maps back cleanly
3. **Extracts just that region and sends it for re-rendering** — with your notes attached ("change 36GB to 96GB", "fix the garbled text here")
4. **Histogram-matches the result** — per-channel RGB normalization so the fixed region's brightness and contrast match the original exactly
5. **Composites it back** — the fixed region drops into the original image seamlessly

By reducing the scope to a small region with limited text, the renderer handles it cleanly every time.

## The Technical Details

### Aspect Ratio Snapping

Image generation models only produce standard aspect ratios. If you crop a 300x200 region, you can't send that to the model and expect a 300x200 result. The tool computes the nearest supported ratio (in this case 3:2), adjusts the crop boundaries to match while keeping the same center point, and clamps to image bounds. After processing, the result is resized back to the exact pixel dimensions of the adjusted crop.

### Histogram Matching

This was the key to making composited regions invisible. Without it, the re-rendered region would come back slightly brighter or with different contrast — an obvious patch.

The fix: compute per-channel (R, G, B) mean and standard deviation for both the original crop and the re-rendered crop, then apply a linear transform:

```
output = (input - rendered_mean) * (original_stdev / rendered_stdev) + original_mean
```

With multipliers clamped between 0.5x and 2.0x to avoid extreme corrections. The result blends seamlessly with the surrounding image.

### Human-in-the-Loop MCP

The most unusual part of the architecture is the interaction model. This is an MCP (Model Context Protocol) server — a tool that AI assistants can call. But unlike typical fire-and-forget tools, this one has a **human-in-the-loop step mid-execution**:

1. The AI assistant calls the `interactive_fix` tool
2. The tool opens a browser-based crop UI
3. The tool *blocks* — it's awaiting a Promise that resolves when the user submits
4. The user draws their selection, adds notes, hits Submit
5. The browser POSTs coordinates back to the tool's HTTP server
6. The HTTP response is held open while Gemini processes
7. The browser gets the result back when processing completes
8. The MCP tool returns the final image to the AI assistant

The AI initiated it, the human guided it, the AI gets the result. Three-way handoff in a single tool call.

## Why This Matters Beyond My Project

Every company adopting AI image generation for anything text-heavy — marketing collateral, product packaging, technical diagrams, signage — hits this wall. The models are good enough to use, but not reliable enough to trust. Someone on the team ends up in Photoshop fixing garbled text by hand.

The pattern here isn't specific to my implementation. Region-based repair with histogram-matched compositing works with any image generation model. The core insight is:

**Don't fight the model's limitations. Reduce the scope until the model can handle it.**

That's a principle that applies well beyond image generation.

---

*Built with TypeScript, sharp, Google Gemini, and the Model Context Protocol. The tool is part of the nanobanana2 MCP server.*

*John Evans is the founder of Duval Software, building AI-powered inspection and analysis tools. Reach out at jakepevans@gmail.com.*
