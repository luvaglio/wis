-- Give the assistant a clock.
--
-- Nothing in the context told it the date, so it answered "what day is it"
-- from whatever the model happened to assume. That also quietly corrupts
-- anything relative: "Friday", "next week", "in an hour" cannot be resolved
-- without knowing now.
--
-- IANA name, for example "Europe/London". Null means we have not been told,
-- and the assistant is given UTC and said so rather than guessing a locale.

ALTER TABLE preferences ADD COLUMN timezone TEXT;
