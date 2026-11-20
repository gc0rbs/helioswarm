// The mint server: `--mint` serves the mint page and its JSON API. No dependencies, like the
// dashboard. Owner actions take the owner token as a Bearer token.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { MINT_PAGE } from "./page";
import { MintError, type MintService } from "./service";

const BODY_LIMIT = 16 * 1024;
/** New orders one address may open per window. */
const ORDER_LIMIT = 20;
const ORDER_WINDOW_MS = 10 * 60_000;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_LIMIT) throw new MintError(413, "request body is too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new MintError(400, "request body must be a JSON object");
  }
}

const bearer = (req: IncomingMessage): string | undefined => {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

const note = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><body style="background:#000;color:#EEF0F2;font:16px system-ui;padding:48px 16px;max-width:560px;margin:auto"><h1 style="font-size:20px">${esc(title)}</h1><p style="color:#9B9B9B">${esc(text)}</p><p><a style="color:#FF8A3D" href="/">Back to the mint</a></p>`;

export function mintHandler(svc: MintService, now: () => number = Date.now) {
  const opened = new Map<string, number[]>();
  const limited = (ip: string): boolean => {
    const t = now();
    const hits = (opened.get(ip) ?? []).filter((x) => t - x < ORDER_WINDOW_MS);
    if (hits.length >= ORDER_LIMIT) return true;
    hits.push(t);
    opened.set(ip, hits);
    if (opened.size > 10_000) for (const [k, v] of opened) if (!v.some((x) => t - x < ORDER_WINDOW_MS)) opened.delete(k);
    return false;
  };

  const clientOf = (req: IncomingMessage): string => {
    const fwd = svc.cfg.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() : "";
    return fwd || req.socket.remoteAddress || "?";
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://mint.local");
    const parts = url.pathname.split("/").filter(Boolean);
    const m = req.method ?? "GET";
    try {
      if (m === "GET" && parts.length === 0) return html(res, 200, MINT_PAGE);
      if (m === "GET" && url.pathname === "/x/callback") {
        // X sends the owner's browser here. Errors are shown as a page, not JSON.
        try {
          if (url.searchParams.get("error")) throw new MintError(400, "X sign-in was cancelled.");
          const a = await svc.xFinish(url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "");
          return html(res, 200, note("X account linked", `@${a.x?.handle ?? ""} is now linked to ${a.name}.`));
        } catch (e) {
          return html(res, e instanceof MintError ? e.status : 502, note("X link failed", e instanceof MintError ? e.message : "X could not be reached. Try again from your agent."));
        }
      }
      if (parts[0] !== "api") throw new MintError(404, "not found");

      if (parts[1] === "mint") {
        if (m === "GET" && parts[2] === "config" && parts.length === 3) return send(res, 200, svc.info());
        if (parts[2] === "orders") {
          if (m === "POST" && parts.length === 3) {
            if (limited(clientOf(req))) throw new MintError(429, "too many orders from this address, try again later");
            const b = await readJson(req);
            return send(res, 201, svc.createOrder({ name: b.name as string, preset: b.preset as string, persona: b.persona as string, tier: b.tier as string, github: b.github as string }));
          }
          if (m === "GET" && parts.length === 4) return send(res, 200, await svc.orderStatus(parts[3]!));
          if (m === "POST" && parts.length === 5 && parts[4] === "confirm") {
            const b = await readJson(req);
            return send(res, 200, await svc.confirm(parts[3]!, b.signature as string));
          }
        }
      }

      if (parts[1] === "agents") {
        if (m === "GET" && parts.length === 2) return send(res, 200, svc.listAgents());
        const id = parts[2];
        if (id) {
          const tok = bearer(req);
          if (m === "GET" && parts.length === 3) return send(res, 200, svc.ownerView(id, tok));
          if (m === "GET" && parts.length === 4 && parts[3] === "code") return send(res, 200, svc.codeBundle(id, tok));
          if (m === "POST" && parts.length === 4 && parts[3] === "upgrade") {
            if (limited(clientOf(req))) throw new MintError(429, "too many orders from this address, try again later");
            const b = await readJson(req);
            return send(res, 201, svc.createUpgrade(id, tok ?? "", b.github as string | undefined));
          }
          if (m === "POST" && parts.length === 4 && parts[3] === "github") {
            const b = await readJson(req);
            return send(res, 200, await svc.setGithub(id, tok, b.github as string));
          }
          if (parts.length === 4 && parts[3] === "x") {
            if (m === "POST") return send(res, 200, svc.xStart(id, tok));
            if (m === "DELETE") return send(res, 200, await svc.xUnlink(id, tok));
          }
        }
      }
      throw new MintError(404, "not found");
    } catch (e) {
      if (e instanceof MintError) return send(res, e.status, { error: e.message });
      console.error(`[mint] ${m} ${url.pathname}: ${(e as Error).message}`);
      return send(res, 500, { error: "something went wrong on our side" });
    }
  };
}

export function startMintServer(svc: MintService, port: number): Server {
  const handle = mintHandler(svc);
  const server = createServer((req, res) => void handle(req, res));
  server.listen(port, "0.0.0.0", () => console.log(`\n  Mint: http://localhost:${port}\n`));
  return server;
}
