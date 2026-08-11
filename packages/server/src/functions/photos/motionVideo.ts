import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName } from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { canAccessPhotoPath } from "../../utils/auth/photoAccess";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";

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

  // ---- vivo VivoLivePhoto:LivePhotoOffset / LivePhotoLength ----
  // Semantics: value = byte count of embedded video measured from EOF
  // Covers:
  //   - double quotes:   VivoLivePhoto:LivePhotoOffset="123456"
  //   - single quotes:   VivoLivePhoto:LivePhotoOffset='123456'
  //   - element form:    <VivoLivePhoto:LivePhotoOffset>123456</...>
  //   - Length variant:  VivoLivePhoto:LivePhotoLength="123456"
  const vivoMatch =
    headerText.match(/LivePhoto(?:Offset|Length)[=\s]*["'](\d+)["']/) ||
    headerText.match(/LivePhoto(?:Offset|Length)[^>]*>(\d+)</);
  if (vivoMatch) {
    const length = parseInt(vivoMatch[1], 10);
    const offset = totalSize - length;
    if (offset > 1000 && length > 0 && offset < totalSize) {
      return { offset, length };
    }
  }

  // ---- Android 12+ Container Directory ----
  // Google: <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="N"/>
  // Samsung variant: <Container:Item Container:Mime="video/mp4" Container:Length="N"/>
  // NOTE: use [\s\S]*? so the slash in "video/mp4" does not break the match.
  const itemRe = /<Container:Item\b([\s\S]*?)(?:\/? *>)/g;
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

  // ---- Huawei newer format: <rdf:Description ... Item:Mime="video/mp4" Item:Length="N"/> ----
  // Different from Container:Item — uses rdf:Description with Item:* attributes directly.
  const rdDescRe = /<rdf:Description\b([\s\S]*?)(?:\/?\s*>)/g;
  while ((m = rdDescRe.exec(headerText)) !== null) {
    const attrs = m[1];
    if ((attrs.includes("video/mp4") || attrs.includes("video/quicktime")) && attrs.includes("Item:Length")) {
      const lenMatch = attrs.match(/Item:Length="(\d+)"/);
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
 * Known MP4/QuickTime ftyp major brands — used to validate a found ftyp box.
 * All are 4 ASCII bytes (padded with space when < 4 chars).
 */
const KNOWN_VIDEO_BRANDS = new Set([
  "isom", "iso2", "iso3", "iso4", "iso5",
  "mp41", "mp42", "avc1", "M4V ", "M4P ",
  "qt  ",                                    // Apple QuickTime
  "3gp4", "3gp5", "3gp6", "3gp7",
  "3g2a", "3g2b", "3g2c",
  "mmp4", "f4v ", "isop", "hevc", "hvc1",
]);

/**
 * Front-embedded detection: some phones (newer vivo OriginOS) prepend the
 * MP4 video BEFORE the JPEG rather than appending it after.
 * File layout: [MP4 video bytes][JPEG bytes]
 *
 * Detection: if bytes 4–8 of the header == "ftyp" (standard MP4 box), scan
 * forward for the JPEG SOI marker (FF D8 FF E0/E1/E2) to find the boundary.
 * Returns { offset: 0, length: jpegStart }.
 */
function findFrontEmbeddedVideoRange(
  headerBuf: Buffer,
): { offset: number; length: number } | null {
  if (headerBuf.length < 12) return null;
  if (headerBuf.toString("ascii", 4, 8) !== "ftyp") return null;
  // Validate brand is a plausible video brand
  const brand = headerBuf.toString("ascii", 8, 12);
  if (!KNOWN_VIDEO_BRANDS.has(brand) && !/^[A-Za-z0-9 ]{4}$/.test(brand)) return null;
  // Scan for JPEG SOI: FF D8 FF E0/E1/E2
  for (let i = 8; i < headerBuf.length - 3; i++) {
    if (
      headerBuf[i] === 0xff &&
      headerBuf[i + 1] === 0xd8 &&
      headerBuf[i + 2] === 0xff &&
      headerBuf[i + 3] >= 0xe0 &&
      headerBuf[i + 3] <= 0xef
    ) {
      if (i > 1000) return { offset: 0, length: i };
    }
  }
  return null;
}

/**
 * Binary fallback: locate the embedded MP4 inside a motion JPEG.
 *
 * Strategy 1 – EOI→ftyp:
 *   Find JPEG EOI (FF D9), then look for MP4 ftyp box within 512 bytes.
 *   Handles Huawei HwMotionPhoto and phones with small EOI→MP4 gaps.
 *
 * Strategy 2 – standalone ftyp scan:
 *   Search the tail buffer for any ftyp box whose major brand is a known
 *   video brand.  This catches phones where the JPEG EOI is BEFORE the
 *   tail window (i.e. the embedded video is > tailSize bytes).
 */
function findMotionVideoByBinary(
  trailingBuf: Buffer,
  totalSize: number,
): { offset: number; length: number } | null {
  const tailStartOffset = totalSize - trailingBuf.length;

  // ── Strategy 1: JPEG EOI (FF D9) → ftyp within 64 bytes ─────────────────
  for (let i = 0; i < trailingBuf.length - 8; i++) {
    if (trailingBuf[i] === 0xff && trailingBuf[i + 1] === 0xd9) {
      const searchEnd = Math.min(i + 514, trailingBuf.length - 8);
      for (let j = i + 2; j < searchEnd; j++) {
        const atomType = trailingBuf.toString("ascii", j + 4, j + 8);
        if (atomType === "ftyp") {
          const fileOffset = tailStartOffset + j;
          const length = totalSize - fileOffset;
          if (fileOffset > 1000 && length > 0) {
            return { offset: fileOffset, length };
          }
        }
      }
    }
  }

  // ── Strategy 2: find any valid ftyp box with a known video brand ─────────
  // Useful when the JPEG EOI is before the tail window (large embedded video).
  for (let i = 0; i < trailingBuf.length - 12; i++) {
    const atomType = trailingBuf.toString("ascii", i + 4, i + 8);
    if (atomType !== "ftyp") continue;
    // Validate box size: ftyp header is typically 16–32 bytes, never > 256
    const boxSize = trailingBuf.readUInt32BE(i);
    if (boxSize < 8 || boxSize > 256) continue;
    // Validate major brand
    const brand = trailingBuf.toString("ascii", i + 8, i + 12);
    if (!KNOWN_VIDEO_BRANDS.has(brand) && !/^[A-Za-z0-9 ]{4}$/.test(brand)) continue;
    const fileOffset = tailStartOffset + i;
    // Video must start in the second quarter of the file or later
    if (fileOffset > totalSize / 4 && fileOffset < totalSize) {
      const length = totalSize - fileOffset;
      return { offset: fileOffset, length };
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

    if (!await canAccessPhotoPath(blobName, payload, isGroupMember)) {
      return {
        status: 403,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Forbidden" }),
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

      // Detect Apple Live Photo JPEG early — the video is a *separate* .mov file
      // and is NOT embedded in the JPEG itself.  Return a clear error rather than
      // wasting time scanning for a video that isn't there.
      const isAppleLivePhoto =
        headerText.includes("apple_fi") || headerText.includes("Photos:Live");
      if (isAppleLivePhoto) {
        context.log(`[motionVideo] ${blobName}: detected Apple Live Photo JPEG — video not embedded`);
        return {
          status: 422,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            error: "Apple 实况照片（Live Photo）的视频部分是独立文件，无法从 JPEG 中提取。请以 HEIC 格式上传以保留动态效果。",
            reason: "apple-live-photo",
          }),
        };
      }

      // Detect which XMP markers are present (for diagnostic logging)
      const xmpMarkers = ["MotionPhoto", "MicroVideo", "GCamera", "HwMotionPhoto", "VivoLivePhoto"]
        .filter((m) => headerText.includes(m));
      context.log(`[motionVideo] ${blobName}: size=${totalSize}, xmpMarkers=[${xmpMarkers.join(",")}]`);

      let range = findMotionVideoRange(headerText, totalSize);
      context.log(`[motionVideo] ${blobName}: XMP range=${range ? `offset=${range.offset} len=${range.length}` : "null"}`);

      // Step 3a (fallback): front-embedded video (video BEFORE JPEG, e.g. newer vivo OriginOS)
      if (!range) {
        range = findFrontEmbeddedVideoRange(headerBuf);
        context.log(`[motionVideo] ${blobName}: front-embedded range=${range ? `offset=${range.offset} len=${range.length}` : "null"}`);
      }

      // Step 3b (fallback): binary scan of the last 8 MB for JPEG EOI → ftyp.
      // 256 KB was too small — many phones embed videos > 256 KB so the JPEG
      // EOI marker fell before the tail window.  8 MB covers virtually all
      // motion-photo video tracks in the wild.
      if (!range) {
        const tailSize = Math.min(8 * 1024 * 1024, totalSize);
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
        context.log(`[motionVideo] ${blobName}: binary range=${range ? `offset=${range.offset} len=${range.length}` : "null"}`);
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
