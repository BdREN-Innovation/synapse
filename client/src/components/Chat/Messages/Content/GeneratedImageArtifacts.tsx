import type { TAttachment } from 'librechat-data-provider';
import Image from './Image';

/**
 * Renders attachments for images a model returned inline on its chat
 * completion (e.g. OpenRouter's `message.images` extension for Gemini image
 * models) rather than through a tool call. `ContentParts`' normal attachment
 * routing keys everything by `toolCallId` (`mapAttachments`), so an attachment
 * with none — as these are, since no tool produced them — would otherwise never
 * find a content part to attach to and render under. Mirrors `MemoryArtifacts`:
 * an unconditional, tool-call-independent slot filtered by attachment shape.
 */
export default function GeneratedImageArtifacts({
  attachments,
}: {
  attachments?: TAttachment[];
}) {
  if (!attachments || attachments.length === 0) {
    return null;
  }

  const images = attachments.filter(
    (attachment) =>
      attachment != null &&
      !attachment.toolCallId &&
      typeof attachment.type === 'string' &&
      attachment.type.startsWith('image/') &&
      typeof attachment.filepath === 'string',
  );

  if (images.length === 0) {
    return null;
  }

  return (
    <>
      {images.map((image) => {
        /** `file_id`/`width`/`height` only exist on the `TFile`-backed branch of
         *  the `TAttachment` union; runtime objects saved via `saveBase64Image`
         *  always carry them, so this narrows what the union type can't. */
        const file = image as TAttachment & { file_id?: string; width?: number; height?: number };
        return (
          <Image
            key={file.file_id ?? file.filepath}
            imagePath={file.filepath as string}
            altText={file.filename ?? 'Generated image'}
            width={file.width}
            height={file.height}
          />
        );
      })}
    </>
  );
}
