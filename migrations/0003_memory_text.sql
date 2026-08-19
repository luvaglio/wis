-- Keep the text of each memory chunk alongside its vector id.
--
-- The text already lives in Vectorize metadata, but reading it back means
-- fetching full float arrays for every chunk just to render a list. Settings
-- needs to show people what their assistant remembers about them, and
-- "download or delete it at any time" (site/values) is easier to honour when
-- the readable copy is in the same place as the id.

ALTER TABLE memory_chunks ADD COLUMN text TEXT;
