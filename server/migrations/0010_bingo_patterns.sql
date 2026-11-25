-- What wins the bingo game: 'regular' (any line), 'z', 'x', 'box' (the outside edge) or 'coverall'.
ALTER TABLE bingo_games ADD COLUMN pattern TEXT NOT NULL DEFAULT 'regular';
