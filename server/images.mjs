import dns from "node:dns";
import https from "node:https";
import net from "node:net";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_INPUT_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 128;

const FORMATS = {
  "image/jpeg": {
    extension: ".jpg",
    matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  "image/png": {
    extension: ".png",
    matches: (bytes) => bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  },
  "image/webp": {
    extension: ".webp",
    matches: (bytes) => bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP",
  },
  "image/gif": {
    extension: ".gif",
    matches: (bytes) => bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a",
  },
};

const blockedIPv4 = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  blockedIPv4.addSubnet(address, prefix, "ipv4");
}

const globalIPv6 = new net.BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
const blockedIPv6 = new net.BlockList();
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
]) {
  blockedIPv6.addSubnet(address, prefix, "ipv6");
}

function isPublicAddress(address, family) {
  if (family === 4) return !blockedIPv4.check(address, "ipv4");
  return family === 6 && globalIPv6.check(address, "ipv6") && !blockedIPv6.check(address, "ipv6");
}

function lookupPublicAddress(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
      return callback(new Error("image_url hostname must resolve only to public addresses."));
    }
    if (options?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

function parseImageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("image_url must be a valid HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local") ||
    url.hostname.endsWith(".internal")
  ) {
    throw new Error("image_url must use HTTPS and point to a public host.");
  }
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  const family = net.isIP(literal);
  if (family && !isPublicAddress(literal, family)) {
    throw new Error("image_url must point to a public host.");
  }
  url.hash = "";
  return url;
}

function validateImageBytes(bytes, expectedMimeType) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("The decoded image must be no larger than 5 MB.");
  }
  const mimeType = Object.keys(FORMATS).find((candidate) => FORMATS[candidate].matches(bytes));
  if (!mimeType) throw new Error("The image must be a JPEG, PNG, WebP, or GIF.");
  if (expectedMimeType && expectedMimeType !== mimeType) {
    throw new Error("The image bytes do not match mime_type.");
  }
  return { bytes, mimeType, extension: FORMATS[mimeType].extension };
}

export function decodeImageInput(image, declaredMimeType) {
  let base64 = image.trim();
  let expectedMimeType = declaredMimeType;
  if (base64.startsWith("data:")) {
    const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(base64);
    const dataUrlMime = dataUrl?.[1].toLowerCase();
    if (!dataUrl || !FORMATS[dataUrlMime]) {
      throw new Error("Use a JPEG, PNG, WebP, or GIF image encoded as base64.");
    }
    if (expectedMimeType && expectedMimeType !== dataUrlMime) {
      throw new Error("mime_type does not match the image data URL.");
    }
    expectedMimeType = dataUrlMime;
    base64 = dataUrl[2];
  }

  base64 = base64.replace(/\s/g, "");
  if (
    base64.length === 0 ||
    base64.length > MAX_IMAGE_INPUT_CHARS ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  ) {
    throw new Error("image_base64 is invalid or larger than 5 MB.");
  }
  if (!expectedMimeType || !FORMATS[expectedMimeType]) {
    throw new Error("mime_type is required for raw base64 and must be a supported image type.");
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) throw new Error("image_base64 must use valid padded base64.");
  return validateImageBytes(bytes, expectedMimeType);
}

export function downloadImageFromUrl(value, expectedMimeType) {
  return requestImage(parseImageUrl(value), expectedMimeType, 0);
}

function requestImage(url, expectedMimeType, redirects) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: { accept: "image/jpeg,image/png,image/webp,image/gif,application/octet-stream" },
        lookup: lookupPublicAddress,
      },
      (response) => {
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.resume();
          if (!location || redirects >= 3) {
            finish(new Error("image_url redirected too many times or omitted its target."));
            return;
          }
          let nextUrl;
          try {
            nextUrl = parseImageUrl(new URL(location, url).href);
          } catch (err) {
            finish(err);
            return;
          }
          finish(null, requestImage(nextUrl, expectedMimeType, redirects + 1));
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          finish(new Error(`image_url returned HTTP ${status}.`));
          return;
        }

        const contentType = (response.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
        if (contentType && contentType !== "application/octet-stream" && !FORMATS[contentType]) {
          response.resume();
          finish(new Error("image_url did not return a supported image type."));
          return;
        }
        const contentLength = Number(response.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
          response.resume();
          finish(new Error("The image must be no larger than 5 MB."));
          return;
        }

        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) {
            request.destroy(new Error("The image must be no larger than 5 MB."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const declaredType = contentType === "application/octet-stream" ? undefined : contentType;
            const result = validateImageBytes(Buffer.concat(chunks, size), expectedMimeType || declaredType);
            finish(null, result);
          } catch (err) {
            finish(err);
          }
        });
      },
    );

    const timeout = setTimeout(() => request.destroy(new Error("image_url download timed out.")), 20_000);
    timeout.unref?.();
    let settled = false;
    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve(result);
    }
    request.on("error", (err) => finish(err));
    request.end();
  });
}
