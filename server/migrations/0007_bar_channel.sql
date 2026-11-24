-- What the bar's own channel shows: {"enabled","onNow","later","events","posters": booleans,
-- "hiddenMenus": [menu ids], "seconds": per page}. NULL means the defaults: everything, 12 seconds a page.
ALTER TABLE venues ADD COLUMN channel TEXT;
