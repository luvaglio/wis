-- Store city separately from a free-text address.
--
-- The address was one open text box, which meant no two accounts described a
-- location the same way. Country is now a code from a fixed list and city is
-- its own field, so "where is this person" is answerable without parsing prose.
-- The old address column is kept for anyone who already filled it in.

ALTER TABLE users ADD COLUMN city TEXT;
