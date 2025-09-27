// web/index.ts
import express, { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import path from "path";

const app = express();
const prisma = new PrismaClient();

// Trust proxy (Shopify CLI tunnel / Cloudflare)
app.set("trust proxy", true);

// Let Shopify Admin embed this app (CSP-lite)
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com;"
  );
  res.setHeader("X-Frame-Options", "ALLOWALL");
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function log(...args: any[]) {
  console.log(new Date().toISOString(), ...args);
}

function toProductGid(id: string | number): string | null {
  const s = String(id);
  if (s.startsWith("gid://shopify/Product/")) return s;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? `gid://shopify/Product/${n}` : null;
}

function sendHtml(
  res: Response,
  opts: { ok: boolean; returnTo?: string; id?: string; message?: string }
) {
  const { ok, returnTo = "/", id, message } = opts;
  const esc = (v = "") => String(v).replace(/"/g, "&quot;");
  const html = `<!doctype html>
<meta charset="utf-8">
<title>${ok ? "Thanks!" : "We couldn't save your review"}</title>
<style>body{font:16px/1.4 system-ui, sans-serif; padding:24px}</style>
<h1>${ok ? "Thanks for your review!" : "We couldn't save your review"}</h1>
${id ? `<p>Review ID: ${id}</p>` : ""}
${message ? `<p><small>${message}</small></p>` : ""}
<p><a href="${esc(returnTo)}">Continue</a></p>
<script>location.replace(${JSON.stringify(returnTo)});</script>`;
  return res.status(200).type("text/html").send(html);
}

// ---------- Health ----------
app.all("/reviews/ping", (_req, res) =>
  res.status(200).type("text/plain").send("ok from /reviews/ping")
);

// ---------- ADMIN HOME (fixes “Invalid path /?”) ----------
app.get("/", (req, res) => {
  const shop = String(req.query.shop || "");
  const host = String(req.query.host || "");
  const apiKey = process.env.SHOPIFY_API_KEY || "";

  res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>App Reviews</title>
    <script src="https://unpkg.com/@shopify/app-bridge@3"></script>
    <style>
      body { font: 14px/1.5 system-ui, sans-serif; padding: 24px; }
      .card { max-width: 720px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>App Reviews</h1>
      <p>Admin home is loaded inside Shopify 🎉</p>
      <p><small>shop: ${shop || "(unknown)"} | host: ${host || "(missing)"} </small></p>
      <p>Use your product page on the storefront to submit reviews via the App Proxy form.</p>
      <ul>
        <li>Health: <code>/reviews/ping</code></li>
        <li>Proxy submit: <code>/reviews/submit</code></li>
      </ul>
    </div>

    <script>
      try {
        const AppBridge = window["app-bridge"];
        if (AppBridge && "${apiKey}" && "${host}") {
          AppBridge.createApp({ apiKey: "${apiKey}", host: "${host}" });
        }
      } catch (e) {}
    </script>
  </body>
</html>`);
});

// ---------- APP PROXY: /apps/app-reviews/submit -> /reviews/submit ----------
app.all("/reviews/submit", async (req: Request, res: Response) => {
  log(`[${req.method}] /reviews/submit`, { query: req.query });

  const shop =
    (req.query.shop as string) ||
    (req.headers["x-shopify-shop-domain"] as string) ||
    "";

  const body = (req.body ?? {}) as Record<string, any>;
  const returnTo =
    (body.return_to as string) || (req.query.return_to as string) || "/";

  try {
    if (!shop) {
      log("submit: missing shop");
      return sendHtml(res, { ok: false, returnTo, message: "Missing shop" });
    }

    const productGid = toProductGid(body.product_id ?? body.productId);
    const rating = Number(body.rating);
    const title = String(body.title ?? "");
    const reviewBody = String(body.body ?? "");
    const author = String(body.author ?? "");
    const email = String(body.email ?? "");

    if (!productGid)
      return sendHtml(res, { ok: false, returnTo, message: "Invalid product id" });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5)
      return sendHtml(res, { ok: false, returnTo, message: "Rating must be 1..5" });

    // offline token from Prisma session (seeded by your OAuth flow/CLI)
    const session = await prisma.session.findFirst({
      where: { shop, isOnline: false },
    });
    const accessToken = session?.accessToken;
    if (!accessToken) {
      log("submit: no offline token for", shop);
      return sendHtml(res, {
        ok: false,
        returnTo,
        message: "App not authorized for this shop",
      });
    }

    const apiVersion = "2025-07";
    const mutation = `
      mutation CreateReview($fields: [MetaobjectFieldInput!]!) {
        metaobjectCreate(metaobject: { type: "review", fields: $fields }) {
          metaobject { id }
          userErrors { field message }
        }
      }`;
    const variables = {
      fields: [
        { key: "product", value: productGid },
        { key: "rating", value: String(rating) },
        { key: "title", value: title },
        { key: "body", value: reviewBody },
        { key: "author", value: author },
        { key: "email", value: email },
        { key: "status", value: "approved" },
        { key: "created", value: new Date().toISOString() },
      ],
    };

    const resp = await fetch(
      `https://${shop}/admin/api/${apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: mutation, variables }),
      }
    );

    const raw = await resp.text();
    log("GraphQL status", resp.status, "body", raw.slice(0, 600));
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      return sendHtml(res, { ok: false, returnTo, message: "API returned non-JSON" });
    }

    const errs = json?.data?.metaobjectCreate?.userErrors ?? [];
    if (errs.length) {
      log("submit: userErrors", errs);
      return sendHtml(res, { ok: false, returnTo, message: "Validation error" });
    }

    const id: string | undefined =
      json?.data?.metaobjectCreate?.metaobject?.id;
    log("submit: review created", id);
    return sendHtml(res, { ok: true, id, returnTo });
  } catch (err) {
    log("submit error:", err);
    return sendHtml(res, { ok: false, returnTo, message: "Server error" });
  }
});

// ---------- LAST: 404 as JSON (no “Invalid path …” text) ----------
app.use((req, res) =>
  res.status(404).json({ error: `No route: ${req.method} ${req.path}` })
);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => log(`web | listening on ${port}`));
