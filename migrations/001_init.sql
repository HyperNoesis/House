-- Ilé — initial Postgres schema.
-- Run with: psql "$DATABASE_URL" -f migrations/001_init.sql
-- (or `npm run migrate`, see package.json / README)

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'seeker',
  tier TEXT,
  avatar_seed TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  lat REAL,
  lng REAL,
  price_value REAL NOT NULL,
  period TEXT NOT NULL DEFAULT '/year',
  beds INTEGER NOT NULL,
  baths INTEGER NOT NULL,
  tag TEXT DEFAULT 'New',
  status TEXT NOT NULL DEFAULT 'active',
  verified INTEGER NOT NULL DEFAULT 0,
  verify_identity INTEGER NOT NULL DEFAULT 0,
  verify_property INTEGER NOT NULL DEFAULT 0,
  verify_location INTEGER NOT NULL DEFAULT 0,
  amenities TEXT NOT NULL DEFAULT '[]',
  description TEXT DEFAULT '',
  gradient_seed TEXT DEFAULT 'amber',
  cover_image_url TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_properties_status ON properties(status);
CREATE INDEX IF NOT EXISTS idx_properties_owner ON properties(owner_id);

CREATE TABLE IF NOT EXISTS property_media (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  budget REAL,
  location TEXT,
  beds INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'New',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_property ON leads(property_id);

CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  reason TEXT NOT NULL,
  reported_by_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL DEFAULT 'post',
  caption TEXT DEFAULT '',
  property_id INTEGER REFERENCES properties(id),
  media_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(type, status);

CREATE TABLE IF NOT EXISTS likes (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  UNIQUE(post_id, user_id)
);

CREATE TABLE IF NOT EXISTS saves (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  UNIQUE(post_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

CREATE TABLE IF NOT EXISTS follows (
  id SERIAL PRIMARY KEY,
  follower_id INTEGER NOT NULL REFERENCES users(id),
  followee_id INTEGER NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  UNIQUE(follower_id, followee_id)
);

CREATE TABLE IF NOT EXISTS saved_properties (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, property_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id),
  user_a INTEGER NOT NULL REFERENCES users(id),
  user_b INTEGER NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  UNIQUE(property_id, user_a, user_b)
);

CREATE TABLE IF NOT EXISTS saved_searches (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  query TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_alerts (
  id SERIAL PRIMARY KEY,
  saved_search_id INTEGER NOT NULL REFERENCES saved_searches(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  match_score INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  read_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
