-- Party read receipts for admin dual ticks (buyer vs seller).

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS "buyerLastReadAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "sellerLastReadAt" TIMESTAMPTZ;
