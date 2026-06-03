import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName } from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";

/**
 * Parse XMP header text to locate the embedded motion video.
 *
 * Supported formats:
 *   - Google/Samsung/OPPO/Xiaomi/vivo: GCamera:MicroVideoOffset  (bytes from EOF, attribute or element form)
 *   - Android 12+ Container Directory: <Container:Item Item:Mime="video/mp4" Item:Length="N">
 *     Also handles Samsung's variant which uses Container:Length instead of Item:Length
 *   - Older Pixel: GCamera:MicroVideo + GCamera:MicroVideoOffset
 */
function findMotionVideoRange(
  headerText: string,
  totalSize: number,
): { offset: number; length: number } | null {
  // ---- Google/Samsung legacy: MicroVideoOffset ----
  // Handles both attribute form: MicroVideoOffset="12345"
  // and element form: <GCamera:MicroVideoOffset>12345</GCamera:MicroVideoOffset>
  const microMatch =
    headerText.match(/MicroVideoOffset[=\s]*"(\d+)"/) ||
    headerText.match(/MicroVideoOffset[^>]*>(\d+)</);
  if (microMatch) {
    const length = parseInt(microMatch[1], 10);
    const offset = totalSize - length;
    if (offset > 1000 && length > 0 && offset < totalSize) {
      return { offset, length };
    }
  }

  // ---- Android 12+ Container Directory ----
  // Google: <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="N"/>
  // Samsung variant: <Container:Item Container:Mime="video/mp4" Container:Length="N"/>
  // NOTE: use [\s\S]*? so the slash in "video/mp4" does not break the match.
  const itemRe = /<Container:Item\b([\s\S]*?)(?:\/?\s*>)/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(headerText)) !== null) {
    const attrs = m[1];
    if (attrs.includes("video/mp4") || attrs.includes("video/quicktime")) {
      // Accept both Item:Length (Google) and Container:Length (Samsung)
      const lenMatch = attrs.match(/(?:Item|Container):Length="(\d+)"/);
      if (lenMatch) {
        const length = parseInt(lenMatch[1], 10);
        const offset = totalSize - length;
        if (offset > 1000 && length > 0 && offset < totalSize) {
          return { offset, length };
        }
      }
    }
  }

  return null;
}

/**
 * Binary fallback: search the trailing bytes of the file for an MP4 ftyp atom
 * that immediately follows the JPEG EOI marker (0xFF 0xD9).
 * This handles phones (e.g. Huawei HwMotionPhoto) that append the video
 * after the JPEG without recording an explicit offset in XMP.
 */
function findMotionVideoByBinary(
  trailingBuf: Buffer,
  totalSize: number,
): { offset: number; length: number } | null {
  // Scan for JPEG EOI (FF D9), then expect MP4 ftyp box right after
  for (let i = 0; i < trailingBuf.length - 8; i++) {
    if (trailingBuf[i] === 0xff && trailingBuf[i + 1] === 0xd9) {
      const mp4Start = i + 2;
      if (mp4Start + 8 <= trailingBuf.length) {
        // Check for ftyp atom: [4-byte size][ftyp]
        const atomType = trailingBuf.toString("ascii", mp4Start + 4, mp4Start + 8);
        if (atomType === "ftyp") {
          const fileOffset = totalSize - trailingBuf.length + mp4Start;
          const length = totalSize - fileOffset;
          if (fileOffset > 1000 && length > 0) {
            return { offset: fileOffset, length };
          }
        }
      }
    }
  }
  return null;
}

/**
 * GET /api/photos/motion-video?name={blobName}
 *
 * Extracts and returns the embedded MP4 video from a Google/Samsung/OPPO/etc.
 * motion JPEG photo.  Uses two Azure Blob range reads:
 *   1. First 64 KB  — parse XMP to find video offset
 *   2. Video slice  — return just the video bytes
 *
 * Responds with 422 if no embedded video is found.
 */
app.http("motionVideo", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos/motion-video",
  handler: async (
    request: HttpRequest,
    context: InvocationContext,
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(
      request.headers.get("authorization") ?? "",
    );
    if (!payload) {
      return {
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    const blobName = request.query.get("name");
    if (!blobName) {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing name parameter" }),
      };
    }

    try {
      const blobServiceClient = getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);

      // Step 1: get total file size
      const props = await blobClient.getProperties();
      const totalSize = props.contentLength ?? 0;
      if (!totalSize) {
        return {
          status: 404,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Blob not found or empty" }),
        };
      }

      // Step 2: download first 128 KB to parse XMP (larger buffer covers more phones)
      const headerCount = Math.min(131072, totalSize);
      const headerDl = await blobClient.download(0, headerCount);
      const headerChunks: Buffer[] = [];
      for await (const chunk of headerDl.readableStreamBody!) {
        headerChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as ArrayBuffer));
      }
      const headerBuf = Buffer.concat(headerChunks);
      const headerText = headerBuf.toString("latin1");

      let range = findMotionVideoRange(headerText, totalSize);

      // Step 3 (fallback): binary scan of the last 256 KB for JPEG EOI → ftyp.
      // This handles formats like Huawei HwMotionPhoto that don't encode an explicit
      // XMP offset but simply append the MP4 after the JPEG EOI marker.
      if (!range) {
        const tailSize = Math.min(262144, totalSize);
        let tailBuf: Buffer;
        if (tailSize <= headerCount) {
          // The tail is fully covered by the already-downloaded header
          tailBuf = headerBuf.subarray(headerBuf.length - tailSize);
        } else {
          const tailOffset = totalSize - tailSize;
          const tailDl = await blobClient.download(tailOffset, tailSize);
          const tailChunks: Buffer[] = [];
          for await (const chunk of tailDl.readableStreamBody!) {
            tailChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as ArrayBuffer));
          }
          tailBuf = Buffer.concat(tailChunks);
        }
        range = findMotionVideoByBinary(tailBuf, totalSize);
      }

      if (!range) {
        return {
          status: 422,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "此照片中未发现嵌入的动态视频" }),
        };
      }

      // Step 4: download just the video slice
      const videoDl = await blobClient.download(range.offset, range.length);
      const videoChunks: Buffer[] = [];
      for await (const chunk of videoDl.readableStreamBody!) {
        videoChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as ArrayBuffer));
      }
      const videoBuf = Buffer.concat(videoChunks);

      return {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(videoBuf.length),
          "Cache-Control": "private, max-age=3600",
        },
        body: videoBuf,
      };
    } catch (error) {
      context.error("Motion video extraction error:", error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "动态视频提取失败" }),
      };
    }
  },
});
