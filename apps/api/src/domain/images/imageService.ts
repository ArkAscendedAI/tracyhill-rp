import type { GenerateImageRequest, SessionDetailResponse } from "@tracyhill-rp/contracts";
import type { ImageGenerationRuntime } from "@tracyhill-rp/provider-runtime";

import { getImageModel } from "@tracyhill-rp/model-catalog";

import { HttpError } from "../../lib/httpError";
import { createId } from "../../lib/ids";
import { recordSystemEvent } from "../system/systemEvents";
import { ChatService } from "../chat/chatService";
import { MessageRepository } from "../chat/messageRepository";
import { SessionRepository } from "../workspace/sessionRepository";
import { UserRepository } from "../users/userRepository";
import { GeneratedImageRepository } from "./generatedImageRepository";
import { ImageStore } from "./imageStore";

export class ImageService {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly messages: MessageRepository,
    private readonly generatedImages: GeneratedImageRepository,
    private readonly runtimeForUser: (userId: string) => ImageGenerationRuntime | null,
    private readonly store: ImageStore,
    private readonly chat: ChatService,
  ) {}

  async generateForSession(userId: string, sessionId: string, input: GenerateImageRequest, requestId: string): Promise<SessionDetailResponse> {
    this.requireUser(userId);
    this.requireSession(userId, sessionId);
    const runtime = this.runtimeForUser(userId);
    if (!runtime) throw new HttpError(503, "image generation runtime is not configured");
    const model = getImageModel(input.modelId);
    if (!model) throw new HttpError(400, "unsupported image model");

    let generated;
    try {
      generated = await runtime.generateImage({
        modelId: model.id,
        prompt: input.prompt,
        requestId,
      });
    } catch (err) {
      // The error reaches the user, but image generation is fire-and-forget
      // enough in practice that the failure should also land in the system
      // events feed (the source existed with zero recorders).
      recordSystemEvent({
        userId,
        source: "image_generation",
        message: `image generation failed (${model.id}): ${err instanceof Error ? err.message : String(err)}`,
        sessionId,
      });
      throw err;
    }
    const now = new Date().toISOString();
    const messageId = createId();
    const imageId = createId();
    this.messages.createMessageAtTail({
      id: messageId,
      sessionId,
      userId,
      role: "assistant",
      content: `Generated image: ${input.prompt}`,
      modelId: model.id,
      createdAt: now,
      updatedAt: now,
    });
    this.store.write(imageId, generated.mimeType, generated.bytes);
    this.generatedImages.createImage({
      id: imageId,
      messageId,
      sessionId,
      userId,
      prompt: input.prompt,
      mimeType: generated.mimeType,
      createdAt: now,
    });
    this.sessions.updateSession(userId, sessionId, {
      // Same source as every chatService writer: active-only count
      // AFTER the insert, instead of a second hand-rolled definition.
      messageCount: this.messages.countForSession(userId, sessionId),
      updatedAt: now,
      lastMessageAt: now,
    });
    return this.chat.getSessionDetail(userId, sessionId);
  }

  loadImage(userId: string, imageId: string) {
    const image = this.generatedImages.findById(userId, imageId);
    if (!image) throw new HttpError(404, "image not found");
    // The row can outlive the file (a DB-only restore, a manual cleanup of the
    // image dir): a missing file is a 404 for THIS image, not a 500.
    let bytes: Buffer;
    try {
      bytes = this.store.read(image.id, image.mimeType);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "image file not found");
      throw err;
    }
    return {
      // Serve only image types under their stored mime; anything else goes out
      // as an opaque download so a stored non-image mime can never be rendered.
      mimeType: image.mimeType.startsWith("image/") ? image.mimeType : "application/octet-stream",
      bytes,
    };
  }

  private requireUser(userId: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(401, "authentication required");
    return user;
  }

  private requireSession(userId: string, sessionId: string) {
    const session = this.sessions.findActiveById(userId, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    return session;
  }
}
