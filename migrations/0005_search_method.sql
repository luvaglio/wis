-- Put provider-side web search first in every chain that needs facts.
--
-- SPEC 10.1 orders methods cheapest and fastest first. Search on the reasoning
-- provider's own infrastructure is both, and it is the only discovery method
-- that works at all: browsing from the Worker meets a bot challenge at the
-- search engines and a reset connection at many sites, because it runs from
-- datacentre addresses.
--
-- Browsing stays in the chain behind it. It is still the right tool once a URL
-- is known, and it is what runs when search is not configured.

UPDATE task_type_config SET methods = '["search","api","browser","voice"]', updated_at = unixepoch()
  WHERE task_type = 'reservation';
UPDATE task_type_config SET methods = '["search","api","browser"]', updated_at = unixepoch()
  WHERE task_type = 'research';
UPDATE task_type_config SET methods = '["search","email","voice"]', updated_at = unixepoch()
  WHERE task_type = 'outreach';
UPDATE task_type_config SET methods = '["search","api","browser"]', updated_at = unixepoch()
  WHERE task_type = 'generic';
