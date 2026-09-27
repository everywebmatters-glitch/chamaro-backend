import { createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { errorResponse, idParams, notFound, pageMeta, routeSchema } from "../shared/http.js";
import { cleanFilename, detectImageType, isImageMimeType, MAX_IMAGE_BYTES, mediaPath } from "../shared/media.js";

// Unexpected fields (e.g. size, data, id, urlHash) are rejected rather than written to the row.
const body = { type: "object", additionalProperties: false, required: ["url", "filename", "mimeType"], properties: { url: { type: "string", format: "uri" }, filename: { type: "string", maxLength: 500 }, altText: { type: "string", maxLength: 500 }, mimeType: { type: "string", maxLength: 191 }, metadata: { type: "object" } } };
const hashUrl = (url: string) => createHash("sha256").update(url).digest("hex");
// Image bytes are never loaded or returned by the JSON routes; only GET /api/v1/media/:id reads them.
const omitData = { data: true } as const;

type MediaRow = { id: string; url: string | null; size: number | null; [key: string]: unknown };
// Uploaded media are served by this API; externally registered media keep their own URL.
const present = (media: MediaRow) => ({ ...media, url: media.size !== null ? mediaPath(media.id) : media.url });

const httpError = (statusCode: number, code: string, message: string) => Object.assign(new Error(message), { statusCode, code });

export const mediaRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/v1/admin/media", { schema: routeSchema(["Admin", "Media"], "List media metadata", { security: [{ bearerAuth: [] }] }) }, async (request) => { await request.requireAdmin(); const data = await app.prisma.media.findMany({ omit: omitData, orderBy: { createdAt: "desc" }, take: 100 }); return { success: true, data: data.map(present), meta: pageMeta(1, 100, data.length) }; });
  app.get("/api/v1/admin/media/:id", { schema: routeSchema(["Admin", "Media"], "Get media metadata", { security: [{ bearerAuth: [] }], params: idParams }) }, async (request) => { await request.requireAdmin(); const media = await app.prisma.media.findUnique({ where: { id: (request.params as { id: string }).id }, omit: omitData }); if (!media) throw notFound("Media not found"); return { success: true, data: present(media) }; });
  app.post("/api/v1/admin/media", { schema: routeSchema(["Admin", "Media"], "Register externally stored media", { security: [{ bearerAuth: [] }], body }) }, async (request, reply) => { await request.requireAdmin(); const data = request.body as any; const media = await app.prisma.media.create({ data: { ...data, urlHash: hashUrl(data.url) }, omit: omitData }); reply.code(201); return { success: true, data: present(media) }; });

  // Upload one image (multipart/form-data: a `file` part and an optional `altText` field before it).
  // The bytes are stored in Media.data; the response's `url` is the public path that serves them.
  app.post(
    "/api/v1/admin/media/upload",
    {
      schema: routeSchema(["Admin", "Media"], "Upload an image (JPEG, PNG or WebP, up to 5 MB)", {
        security: [{ bearerAuth: [] }],
        consumes: ["multipart/form-data"],
        response: { 413: errorResponse, 415: errorResponse },
      }),
    },
    async (request, reply) => {
      await request.requireAdmin();
      if (!request.isMultipart()) throw httpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the image as multipart/form-data");

      const file = await request.file();
      if (!file) throw httpError(400, "FILE_REQUIRED", "Choose an image to upload");

      let data: Buffer;
      try {
        data = await file.toBuffer();
      } catch (error) {
        if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw httpError(413, "FILE_TOO_LARGE", `Images must be ${MAX_IMAGE_BYTES / 1024 / 1024} MB or smaller`);
        throw error;
      }
      if (data.length === 0) throw httpError(400, "FILE_EMPTY", "The image file is empty");

      const mimeType = detectImageType(data);
      if (!mimeType) throw httpError(415, "UNSUPPORTED_IMAGE_TYPE", "Only JPEG, PNG and WebP images are accepted");

      const altField = file.fields.altText;
      const altText = altField && "value" in altField && typeof altField.value === "string" ? altField.value.trim().slice(0, 500) : "";

      const media = await app.prisma.media.create({
        data: { filename: cleanFilename(file.filename, mimeType), mimeType, size: data.length, data: new Uint8Array(data), ...(altText ? { altText } : {}) },
        omit: omitData,
      });
      reply.code(201);
      return { success: true, data: present(media) };
    }
  );

  app.put("/api/v1/admin/media/:id", { schema: routeSchema(["Admin", "Media"], "Update media metadata", { security: [{ bearerAuth: [] }], params: idParams, body: { ...body, required: [] } }) }, async (request) => { await request.requireAdmin(); const id = (request.params as { id: string }).id; if (!(await app.prisma.media.findUnique({ where: { id }, select: { id: true } }))) throw notFound("Media not found"); const data = request.body as any; return { success: true, data: present(await app.prisma.media.update({ where: { id }, data: { ...data, ...(data.url ? { urlHash: hashUrl(data.url) } : {}) }, omit: omitData })) }; });
  // Media still shown on a product can't be deleted: the ProductImage foreign key (RESTRICT) makes this a 409 RECORD_IN_USE.
  app.delete("/api/v1/admin/media/:id", { schema: routeSchema(["Admin", "Media"], "Delete media", { security: [{ bearerAuth: [] }], params: idParams }) }, async (request, reply) => { await request.requireAdmin(); const id = (request.params as { id: string }).id; if (!(await app.prisma.media.findUnique({ where: { id }, select: { id: true } }))) throw notFound("Media not found"); await app.prisma.media.delete({ where: { id }, select: { id: true } }); reply.code(204).send(); });

  // Public, read-only: serves an uploaded image's bytes so it can be used directly as <img src>.
  // A media ID's bytes never change, so responses are cacheable for a year.
  app.get(
    "/api/v1/media/:id",
    {
      schema: {
        tags: ["Media"],
        summary: "Get an uploaded image",
        description: "Returns the image bytes with their Content-Type.",
        params: idParams,
        response: { 200: { description: "Image bytes", type: "string", format: "binary" }, 304: { description: "Not modified", type: "null" }, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const media = await app.prisma.media.findUnique({ where: { id }, select: { data: true, mimeType: true } });
      if (!media?.data || !isImageMimeType(media.mimeType)) throw notFound("Media not found");

      const etag = `"${id}"`;
      reply
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .header("ETag", etag)
        .header("X-Content-Type-Options", "nosniff")
        // Defence in depth: nothing in the response may run, even if a browser treated it as a document.
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        // The storefront and Admin load these from a different origin.
        .header("Cross-Origin-Resource-Policy", "cross-origin");
      if (request.headers["if-none-match"] === etag) return reply.code(304).send();
      return reply.type(media.mimeType).send(Buffer.from(media.data.buffer, media.data.byteOffset, media.data.byteLength));
    }
  );
};
