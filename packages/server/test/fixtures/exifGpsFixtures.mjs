function box(kind, payload) {
  const result = Buffer.alloc(8 + payload.length);
  result.writeUInt32BE(result.length, 0);
  result.write(kind, 4, 4, "ascii");
  payload.copy(result, 8);
  return result;
}

function fullBox(kind, version, payload) {
  const fullHeader = Buffer.alloc(4);
  fullHeader.writeUInt8(version, 0);
  return box(kind, Buffer.concat([fullHeader, payload]));
}

function rational(buffer, offset, numerator, denominator = 1) {
  buffer.writeUInt32LE(numerator, offset);
  buffer.writeUInt32LE(denominator, offset + 4);
}

export function createGpsTiff() {
  const tiff = Buffer.alloc(128);
  tiff.write("II", 0, 2, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);

  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);

  tiff.writeUInt16LE(4, 26);
  const entries = [
    { offset: 28, tag: 1, type: 2, count: 2, inline: "N" },
    { offset: 40, tag: 2, type: 5, count: 3, value: 80 },
    { offset: 52, tag: 3, type: 2, count: 2, inline: "E" },
    { offset: 64, tag: 4, type: 5, count: 3, value: 104 },
  ];
  for (const entry of entries) {
    tiff.writeUInt16LE(entry.tag, entry.offset);
    tiff.writeUInt16LE(entry.type, entry.offset + 2);
    tiff.writeUInt32LE(entry.count, entry.offset + 4);
    if (entry.inline) tiff.write(entry.inline, entry.offset + 8, 1, "ascii");
    else tiff.writeUInt32LE(entry.value, entry.offset + 8);
  }

  rational(tiff, 80, 31);
  rational(tiff, 88, 13);
  rational(tiff, 96, 4944, 100);
  rational(tiff, 104, 121);
  rational(tiff, 112, 28);
  rational(tiff, 120, 2532, 100);
  return tiff;
}

export function createGpsJpeg() {
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "binary"), createGpsTiff()]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    exif,
    Buffer.from([0xff, 0xd9]),
  ]);
}

export function createXmpGpsJpeg() {
  const xmp = Buffer.from(
    "<?xpacket begin='\uFEFF' id='W5M0MpCehiHzreSzNTczkc9d'?>"
    + "<x:xmpmeta xmlns:x='adobe:ns:meta/'>"
    + "<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>"
    + "<rdf:Description rdf:about='' xmlns:exif='http://ns.adobe.com/exif/1.0/' "
    + "exif:GPSLatitude='31,13.824N' exif:GPSLongitude='121,28.422E'/>"
    + "</rdf:RDF></x:xmpmeta><?xpacket end='w'?>",
    "utf8",
  );
  const payload = Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
    xmp,
  ]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    payload,
    Buffer.from([0xff, 0xd9]),
  ]);
}

export function createExtendedXmpGpsJpeg() {
  const guid = "0123456789ABCDEF0123456789ABCDEF";
  const mainXmp = Buffer.from(
    "<x:xmpmeta xmlns:x='adobe:ns:meta/'>"
    + "<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>"
    + "<rdf:Description rdf:about='' xmlns:xmpNote='http://ns.adobe.com/xmp/note/' "
    + `xmpNote:HasExtendedXMP='${guid}'/>`
    + "</rdf:RDF></x:xmpmeta>",
    "utf8",
  );
  const extendedXmp = Buffer.from(
    "<x:xmpmeta xmlns:x='adobe:ns:meta/'>"
    + "<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>"
    + "<rdf:Description rdf:about='' xmlns:exif='http://ns.adobe.com/exif/1.0/' "
    + "exif:GPSLatitude='31.2304' exif:GPSLatitudeRef='S' "
    + "exif:GPSLongitude='121.4737' exif:GPSLongitudeRef='W'/>"
    + "</rdf:RDF></x:xmpmeta>",
    "utf8",
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(extendedXmp.length);
  const offset = Buffer.alloc(4);
  offset.writeUInt32BE(0);
  const mainPayload = Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
    mainXmp,
  ]);
  const extendedPayload = Buffer.concat([
    Buffer.from("http://ns.adobe.com/xmp/extension/\0", "ascii"),
    Buffer.from(guid, "ascii"),
    length,
    offset,
    extendedXmp,
  ]);
  const mainApp1 = Buffer.alloc(4);
  mainApp1.writeUInt16BE(0xffe1, 0);
  mainApp1.writeUInt16BE(mainPayload.length + 2, 2);
  const extendedApp1 = Buffer.alloc(4);
  extendedApp1.writeUInt16BE(0xffe1, 0);
  extendedApp1.writeUInt16BE(extendedPayload.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    mainApp1,
    mainPayload,
    extendedApp1,
    extendedPayload,
    Buffer.from([0xff, 0xd9]),
  ]);
}

export function createGpsHeic() {
  const ftypPayload = Buffer.alloc(16);
  ftypPayload.write("mif1", 0, 4, "ascii");
  ftypPayload.write("mif1", 8, 4, "ascii");
  ftypPayload.write("heic", 12, 4, "ascii");
  const ftyp = box("ftyp", ftypPayload);

  const infePayload = Buffer.alloc(9);
  infePayload.writeUInt16BE(1, 0);
  infePayload.writeUInt16BE(0, 2);
  infePayload.write("Exif", 4, 4, "ascii");
  const infe = fullBox("infe", 2, infePayload);
  const iinfCount = Buffer.alloc(2);
  iinfCount.writeUInt16BE(1, 0);
  const iinf = fullBox("iinf", 0, Buffer.concat([iinfCount, infe]));

  const tiff = createGpsTiff();
  const exifExtent = Buffer.concat([Buffer.alloc(4), tiff]);
  const ilocPayload = Buffer.alloc(18);
  ilocPayload.writeUInt8(0x44, 0);
  ilocPayload.writeUInt8(0x00, 1);
  ilocPayload.writeUInt16BE(1, 2);
  ilocPayload.writeUInt16BE(1, 4);
  ilocPayload.writeUInt16BE(0, 6);
  ilocPayload.writeUInt16BE(1, 8);
  const metaLength = 8 + 4 + iinf.length + (8 + 4 + ilocPayload.length);
  ilocPayload.writeUInt32BE(ftyp.length + metaLength, 10);
  ilocPayload.writeUInt32BE(exifExtent.length, 14);
  const iloc = fullBox("iloc", 0, ilocPayload);
  const meta = fullBox("meta", 0, Buffer.concat([iinf, iloc]));

  return Buffer.concat([ftyp, meta, exifExtent]);
}
