-- Order delivery payload for auto-delivery chat message
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "deliveryContent" TEXT;
