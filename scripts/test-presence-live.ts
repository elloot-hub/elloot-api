/**
 * Live presence smoke test against a running API.
 *
 * Requires:
 *   API_URL (default http://localhost:3333)
 *   ADMIN_COOKIE=elloot_admin_at=...
 *   USER_COOKIE=elloot_at=...   (marketplace user who should appear online)
 *   BUYER_ID=...               (same user id expected online in admin chat)
 *
 * Run (PowerShell):
 *   $env:ADMIN_COOKIE="elloot_admin_at=..."; $env:USER_COOKIE="elloot_at=..."; $env:BUYER_ID="..."; npx tsx scripts/test-presence-live.ts
 */
import { io, type Socket } from "socket.io-client";

const API_URL = process.env.API_URL ?? "http://localhost:3333";
const ADMIN_COOKIE = process.env.ADMIN_COOKIE ?? "";
const USER_COOKIE = process.env.USER_COOKIE ?? "";
const BUYER_ID = process.env.BUYER_ID ?? "";

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

function connect(opts: {
  origin: string;
  cookie: string;
  label: string;
}): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(API_URL, {
      path: "/socket.io",
      transports: ["websocket"],
      withCredentials: true,
      extraHeaders: {
        Origin: opts.origin,
        Cookie: opts.cookie,
      },
      autoConnect: true,
    });
    const t = setTimeout(() => {
      socket.close();
      reject(new Error(`${opts.label} connect timeout`));
    }, 8_000);
    socket.on("connect", () => {
      clearTimeout(t);
      resolve(socket);
    });
    socket.on("connect_error", (err) => {
      clearTimeout(t);
      reject(new Error(`${opts.label}: ${err.message}`));
    });
  });
}

async function main() {
  if (!ADMIN_COOKIE || !USER_COOKIE || !BUYER_ID) {
    console.log(
      "Skip live test: set ADMIN_COOKIE, USER_COOKIE and BUYER_ID to run.",
    );
    console.log("Running origin-auth unit checks instead…");
    await import("./test-socket-auth");
    return;
  }

  const userSocket = await connect({
    origin: "http://localhost:3000",
    cookie: `${USER_COOKIE}; ${ADMIN_COOKIE}`,
    label: "marketplace",
  });
  console.log("marketplace connected", userSocket.id);

  const adminSocket = await connect({
    origin: "http://localhost:3001",
    cookie: `${ADMIN_COOKIE}; ${USER_COOKIE}`,
    label: "admin",
  });
  console.log("admin connected", adminSocket.id);

  const online = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 5_000);
    adminSocket.on("presence:update", (payload: { userId: string; online: boolean }) => {
      if (payload.userId === BUYER_ID && payload.online) {
        clearTimeout(t);
        resolve(true);
      }
    });
    adminSocket.emit("presence:subscribe", { userIds: [BUYER_ID] });
  });

  userSocket.close();
  adminSocket.close();

  if (!online) {
    fail(`admin did not see buyer ${BUYER_ID} online`);
  }
  console.log("presence-live: admin saw buyer online — OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
