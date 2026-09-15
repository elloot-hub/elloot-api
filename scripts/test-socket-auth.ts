/**
 * Unit checks for socket cookie/origin resolution (no server required).
 * Run: npx tsx scripts/test-socket-auth.ts
 */
import assert from "node:assert/strict";
import {
  parseCookieValue,
  shouldPreferAdminCookie,
} from "../src/realtime/socket-auth";

// App origin + both cookies → must use marketplace session (presence no userId certo)
assert.equal(
  shouldPreferAdminCookie({
    origin: "http://localhost:3000",
    hasAdminCookie: true,
    hasUserCookie: true,
  }),
  false,
  "app origin must prefer user cookie",
);

// Admin origin + admin cookie → admin panel
assert.equal(
  shouldPreferAdminCookie({
    origin: "http://localhost:3001",
    hasAdminCookie: true,
    hasUserCookie: true,
  }),
  true,
  "admin origin must prefer admin cookie",
);

// Explicit panel flag
assert.equal(
  shouldPreferAdminCookie({
    origin: "http://localhost:3000",
    hasAdminCookie: true,
    hasUserCookie: true,
    authPanel: "admin",
  }),
  true,
  "auth.panel=admin overrides origin",
);

// No origin, only admin cookie
assert.equal(
  shouldPreferAdminCookie({
    origin: undefined,
    hasAdminCookie: true,
    hasUserCookie: false,
  }),
  true,
);

// No origin, both cookies → don't steal marketplace
assert.equal(
  shouldPreferAdminCookie({
    origin: undefined,
    hasAdminCookie: true,
    hasUserCookie: true,
  }),
  false,
);

assert.equal(
  parseCookieValue(
    "foo=1; elloot_admin_at=tok%2B1; elloot_at=user1",
    "elloot_admin_at",
  ),
  "tok+1",
);
assert.equal(
  parseCookieValue("elloot_at=abc", "elloot_admin_at"),
  null,
);

console.log("socket-auth: all checks passed");
