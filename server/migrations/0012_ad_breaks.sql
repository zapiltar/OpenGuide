-- What a bar's TVs show during Pluto TV ad breaks: {"show": "events" | "channel" | "menu" | "picture" | "off",
-- "menuId", "image" (an uploaded image key), "mute": boolean}. NULL means the default: events, sound off.
ALTER TABLE venues ADD COLUMN ad_breaks TEXT;
