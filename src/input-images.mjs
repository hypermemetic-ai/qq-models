// Shared Responses image mapping for Grok and Codex. Inline data (one-shot)
// or durable attachment refs (session / read_image) become input_image parts.

const MEDIA = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function mediaTypeOf(block) {
  const value = block?.mediaType ?? block?.mimeType;
  return MEDIA.has(value) ? value : undefined;
}

export function inputImagePart(block, images) {
  const inlineType = mediaTypeOf(block);
  if (inlineType && typeof block?.data === "string" && block.data) {
    return { type: "input_image", image_url: `data:${inlineType};base64,${block.data}` };
  }
  const ref = block?.attachment;
  const stored = ref?.attachmentId ? images?.get(ref.attachmentId) : undefined;
  if (stored?.base64 && MEDIA.has(stored.mediaType)) {
    return { type: "input_image", image_url: `data:${stored.mediaType};base64,${stored.base64}` };
  }
  return undefined;
}

function walkBlocks(blocks, visit) {
  for (const block of blocks ?? []) {
    visit(block);
    if (block?.type === "tool-result") walkBlocks(block.content, visit);
  }
}

export async function loadInputImages(messages, attachments) {
  const images = new Map();
  if (!attachments || typeof attachments.readImage !== "function") return images;
  const refs = [];
  for (const message of messages ?? []) {
    walkBlocks(message?.content, (block) => {
      if (block?.type === "image" && block.attachment?.attachmentId) refs.push(block.attachment);
    });
  }
  for (const ref of refs) {
    if (images.has(ref.attachmentId)) continue;
    const stored = await attachments.readImage(ref);
    const mediaType = stored?.ref?.mediaType ?? ref.mediaType;
    const data = stored?.data;
    if (!data || !MEDIA.has(mediaType)) continue;
    images.set(ref.attachmentId, {
      mediaType,
      base64: Buffer.from(data).toString("base64"),
    });
  }
  return images;
}

export function toolResultImages(block, images) {
  const parts = [];
  for (const child of Array.isArray(block?.content) ? block.content : []) {
    if (child?.type !== "image") continue;
    const part = inputImagePart(child, images);
    if (part) parts.push(part);
  }
  return parts;
}
