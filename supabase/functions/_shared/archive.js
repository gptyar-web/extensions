import { readBytes } from "./context.js";
import { assert, compareVersions } from "./domain.js";
// Validate directory before decompressing. Reject traversal, duplicates, symlinks and zip bombs.
export async function inspectZip(bytes, expectedVersion) {
  assert(
    bytes.length <= 20 * 1024 * 1024 && bytes.length >= 22,
    "INVALID_PACKAGE_SIZE",
  );
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    text = new TextDecoder("utf-8", { fatal: true });
  let e = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      e = i;
      break;
    }
  assert(
    e >= 0 && v.getUint16(e + 4, true) === 0 && v.getUint16(e + 6, true) === 0,
    "INVALID_ZIP",
  );
  const count = v.getUint16(e + 10, true),
    size = v.getUint32(e + 12, true),
    offset = v.getUint32(e + 16, true);
  assert(count > 0 && count <= 500 && offset + size <= e, "INVALID_ZIP");
  const entries = new Map();
  let p = offset,
    total = 0;
  for (let i = 0; i < count; i++) {
    assert(
      p + 46 <= bytes.length && v.getUint32(p, true) === 0x02014b50,
      "INVALID_ZIP",
    );
    const crc = v.getUint32(p + 16, true),
      flags = v.getUint16(p + 8, true),
      method = v.getUint16(p + 10, true),
      packed = v.getUint32(p + 20, true),
      unpacked = v.getUint32(p + 24, true),
      n = v.getUint16(p + 28, true),
      extra = v.getUint16(p + 30, true),
      comment = v.getUint16(p + 32, true),
      attrs = v.getUint32(p + 38, true),
      start = v.getUint32(p + 42, true);
    assert(p + 46 + n + extra + comment <= offset + size, "INVALID_ZIP");
    const name = text.decode(bytes.subarray(p + 46, p + 46 + n));
    assert(
      name &&
        !name.startsWith("/") &&
        !name.includes("\\") &&
        !name.split("/").includes("..") &&
        !/[\u0000-\u001f]/.test(name) &&
        !entries.has(name),
      "UNSAFE_ZIP_PATH",
    );
    assert(
      ((attrs >>> 16) & 0xf000) !== 0xa000 &&
        !(flags & 1) &&
        [0, 8].includes(method),
      "UNSUPPORTED_ZIP_ENTRY",
    );
    total += unpacked;
    assert(
      total <= 50 * 1024 * 1024 &&
        unpacked <= 10 * 1024 * 1024 &&
        unpacked <= Math.max(1024, packed * 200),
      "ZIP_BOMB",
    );
    entries.set(name, { method, packed, unpacked, start, name, crc });
    p += 46 + n + extra + comment;
  }
  const manifests = [...entries.keys()].filter((x) =>
    /^(?:[^/]+\/)?manifest\.json$/.test(x),
  );
  assert(manifests.length === 1, "MANIFEST_REQUIRED");
  const manifestName = manifests[0],
    prefix = manifestName.slice(0, -13),
    m = entries.get(manifestName);
  assert(m.unpacked <= 64 * 1024, "INVALID_MANIFEST");
  const extract = async (entry) => {
    const s = entry.start;
    assert(
      s + 30 <= bytes.length && v.getUint32(s, true) === 0x04034b50,
      "INVALID_ZIP",
    );
    const length = v.getUint16(s + 26, true);
    assert(
      text.decode(bytes.subarray(s + 30, s + 30 + length)) === entry.name,
      "INVALID_ZIP",
    );
    const begin = s + 30 + length + v.getUint16(s + 28, true);
    assert(begin + entry.packed <= offset, "INVALID_ZIP");
    const data = bytes.subarray(begin, begin + entry.packed);
    const out =
      entry.method === 0
        ? data
        : await readBytes(
            new Response(
              new Blob([data])
                .stream()
                .pipeThrough(new DecompressionStream("deflate-raw")),
            ),
            entry.unpacked,
          );
    assert(
      out.length === entry.unpacked && crc32(out) === entry.crc,
      "INVALID_ZIP",
    );
    return out;
  };
  let manifest;
  try {
    manifest = JSON.parse(text.decode(await extract(m)));
  } catch {
    assert(false, "INVALID_MANIFEST");
  }
  assert(
    manifest.manifest_version === 3 &&
      manifest.name &&
      manifest.version === expectedVersion,
    "MANIFEST_VERSION_MISMATCH",
  );
  compareVersions(expectedVersion, expectedVersion);
  const files = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...Object.values(manifest.icons || {}),
    ...(manifest.content_scripts || []).flatMap((x) => [
      ...(x.js || []),
      ...(x.css || []),
    ]),
  ].filter(Boolean);
  assert(
    files.length > 0 && files.every((x) => entries.has(prefix + x)),
    "PACKAGE_MISSING_FILES",
  );
  // Verify every file can be decompressed, not just the manifest.
  for (const entry of entries.values())
    if (!entry.name.endsWith("/")) await extract(entry);
  let updateEndpoint = null;
  const channel = entries.get(prefix + "release-channel.js"),
    worker = entries.get(prefix + (manifest.background?.service_worker || ""));
  if (channel && worker) {
    const code = text.decode(await extract(channel)),
      background = text.decode(await extract(worker));
    const match =
      /globalThis\.GPTYAR_RELEASE_ENDPOINT\s*=\s*["'](https:\/\/[^"'\s]+)["']\s*;/.exec(
        code,
      );
    if (
      match &&
      code.includes("GPTYARUpdateRequest") &&
      background.includes("globalThis.GPTYARUpdateRequest")
    )
      updateEndpoint = match[1];
  }
  return { manifest, files: entries.size, size: bytes.length, updateEndpoint };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
