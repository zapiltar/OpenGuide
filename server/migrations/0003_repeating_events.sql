-- A repeating event: {"days":[0-6, Sunday is 0],"start":"HH:MM","end":"HH:MM" or null,"from":"YYYY-MM-DD","until":"YYYY-MM-DD" or null},
-- in the bar's time zone. For these, starts_at is the start of "from" and ends_at the end of "until" (NULL: no end),
-- so the feed's date range query covers them too. NULL for a one-time event.
ALTER TABLE events ADD COLUMN repeat TEXT;
