-- A bar's two theme colors ("#rrggbb"), from which the app works out every shade. NULL keeps OpenGuide's colors.
ALTER TABLE venues ADD COLUMN theme_primary TEXT;
ALTER TABLE venues ADD COLUMN theme_secondary TEXT;

-- How a screen shows channels: 'full' picture, or 'framed' with the bar's info along the left and bottom.
ALTER TABLE screens ADD COLUMN layout TEXT NOT NULL DEFAULT 'full';
