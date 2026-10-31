// The private link to the releases bucket: files are served only under the
// secret first path segment (RELEASE_KEY). Anything else is a plain 404.
const encoder = new TextEncoder();
const digest = (text) => crypto.subtle.digest("SHA-256", encoder.encode(text));

export default {
  async fetch(request, env) {
    const notFound = () => new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") return notFound();

    const [, key = "", ...rest] = new URL(request.url).pathname.split("/");
    const path = rest.join("/");
    const allowed = crypto.subtle.timingSafeEqual(await digest(key), await digest(env.RELEASE_KEY));
    if (!allowed || !path) return notFound();

    const object = await (request.method === "HEAD" ? env.BUCKET.head(path) : env.BUCKET.get(path));
    if (!object) return notFound();

    const headers = new Headers({ etag: object.httpEtag, "content-length": String(object.size) });
    object.writeHttpMetadata(headers);
    return new Response(object.body, { headers });
  },
};
