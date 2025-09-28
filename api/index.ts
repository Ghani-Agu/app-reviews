// api/index.ts — Vercel serverless entry (no Prisma, dev-token only)
import express from "express";
import type { Request, Response } from "express";

const app = express();

app.set("trust proxy", true);
app.use((_, res, next) => {
  // Allow embedding in Shopify Admin
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com;"
  );
  res.setHeader("X-Frame-Options", "ALLOWALL");
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function sendHtml(
  res: Response,
  opts: { ok: boolean; returnTo?: string; id?: string; message?: string }
) {
  const { ok, returnTo = "/", id, message } = opts;
  res
    .status(200)
    .type("html")
    .send(`<!doctype html>
<meta charset="utf-8"><style>body{font:16px system-ui;padding:24px}</style>
<h1>${ok ? "Thanks for your review!" : "We couldn't save your review"}</h1>
${id ? `<p>Review ID: ${id}</p>` : ""}${message ? `<p><small>${message}</small></p>` : ""}
<p><a href="${returnTo}">Continue</a></p>
<script>location.replace(${JSON.stringify(returnTo)});</script>`);
}

// ---------- Admin Home ----------
app.get("/", (req, res) => {
  const shop = String(req.query.shop || "");
  const host = String(req.query.host || "");
  const apiKey = process.env.SHOPIFY_API_KEY || "";

  res.type("html").send(`<!doctype html><meta charset="utf-8"/>
<title>App Reviews</title>
<script src="https://unpkg.com/@shopify/app-bridge@3"></script>
<body style="font:14px system-ui;padding:24px">
  <h1>App Reviews</h1>
  <p>Admin home loaded 🎉</p>
  <small>shop: ${shop || "(unknown)"} • host: ${host || "(missing)"}</small>
  <script>
    try {
      const AB = (window as any)["app-bridge"];
      if (AB && "${apiKey}" && "${host}") AB.createApp({ apiKey: "${apiKey}", host: "${host}" });
    } catch (e) {}
  </script>
</body>`);
});

// ---------- Health ----------
app.all("/reviews/ping", (_req, res) =>
  res.status(200).type("text/plain").send("ok from /reviews/ping")
);

// ---------- Helpers ----------
function toProductGid(id: string | number) {
  const s = String(id);
  if (s.startsWith("gid://shopify/Product/")) return s;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? `gid://shopify/Product/${n}` : null;
}

// ---------- App Proxy: /apps/app-reviews/submit → /reviews/submit ----------
app.all("/reviews/submit", async (req: Request, res: Response) => {
  const shop =
    (req.query.shop as string) ||
    (req.headers["x-shopify-shop-domain"] as string) ||
    "";

  const b = (req.body ?? {}) as Record<string, any>;
  const returnTo = (b.return_to as string) || (req.query.return_to as string) || "/";

  try {
    if (!shop) return sendHtml(res, { ok: false, returnTo, message: "Missing shop" });

    // Dev-store shortcut ONLY (no OAuth, no DB)
    const devShop = process.env.DEV_SHOP_DOMAIN;
    const devToken = process.env.DEV_ADMIN_TOKEN;
    if (!devShop || !devToken || shop !== devShop) {
      return sendHtml(res, { ok: false, returnTo, message: "App not authorized for this shop" });
    }

    const productGid = toProductGid(b.product_id ?? b.productId);
    const rating = Number(b.rating);
    const title = String(b.title ?? "");
    const body = String(b.body ?? "");
    const author = String(b.author ?? "");
    const email = String(b.email ?? "");

    if (!productGid) return sendHtml(res, { ok: false, returnTo, message: "Invalid product id" });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return sendHtml(res, { ok: false, returnTo, message: "Rating must be 1..5" });
    }

    const apiVersion = "2025-07";
    const mutation = `
      mutation($fields:[MetaobjectFieldInput!]!){
        metaobjectCreate(metaobject:{type:"review",fields:$fields}){
          metaobject{ id } userErrors{ field message }
        }
      }`;
    const variables = {
      fields: [
        { key: "product", value: productGid },
        { key: "rating", value: String(rating) },
        { key: "title", value: title },
        { key: "body", value: body },
        { key: "author", value: author },
        { key: "email", value: email },
        { key: "status", value: "approved" },
        { key: "created", value: new Date().toISOString() }
      ]
    };

    const r = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": devToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query: mutation, variables })
    });

    const raw = await r.text();
    let json: any;
    try { json = JSON.parse(raw); }
    catch { return sendHtml(res, { ok: false, returnTo, message: "API returned non-JSON" }); }

    const errs = json?.data?.metaobjectCreate?.userErrors ?? [];
    if (errs.length) {
      return sendHtml(res, { ok: false, returnTo, message: "Validation error" });
    }

    const id: string | undefined = json?.data?.metaobjectCreate?.metaobject?.id;
    return sendHtml(res, { ok: true, id, returnTo });
  } catch {
    return sendHtml(res, { ok: false, returnTo, message: "Server error" });
  }
});

// ---------- Export Vercel handler ----------
export default function handler(req: any, res: any) {
  (app as any)(req, res);
}
