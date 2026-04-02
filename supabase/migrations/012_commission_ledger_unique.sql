-- Prevent duplicate commission entries for the same payment + member
-- First clean up any existing duplicates (keep the earliest)
DELETE FROM commission_ledger a
USING commission_ledger b
WHERE a.id > b.id
  AND a.payment_id = b.payment_id
  AND a.member_id = b.member_id;

-- Add unique constraint
ALTER TABLE commission_ledger
  ADD CONSTRAINT unique_payment_member UNIQUE (payment_id, member_id);
