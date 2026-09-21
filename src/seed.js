// seed.js — populates the database with realistic starting data.
// Works against either backend (SQLite locally, Postgres when
// DATABASE_URL is set — see db.js). Safe to re-run: it wipes and
// recreates all rows (not the schema).

const { run, now, usingPostgres } = require("./db");
const { hashPassword } = require("./auth");

const tables = ["messages", "conversations", "saved_properties", "follows", "comments", "saves", "likes", "posts", "reports", "leads", "requests", "property_media", "properties", "users"];

async function main() {
  for (const t of tables) await run(`DELETE FROM ${t}`);
  if (!usingPostgres) {
    // Resets SQLite's AUTOINCREMENT counters so re-seeding gives the same
    // ids every time; Postgres SERIAL sequences don't need (or have) this.
    for (const t of tables) await run(`DELETE FROM sqlite_sequence WHERE name='${t}'`);
  }

  const t0 = now();

  async function seedUser(name, email, password, role, tier) {
    const { lastInsertRowid } = await run("INSERT INTO users (name, email, password, role, tier, created_at) VALUES (?, ?, ?, ?, ?, ?)", [name, email, hashPassword(password), role, tier || null, t0]);
    return lastInsertRowid;
  }

  const adaId = await seedUser("Ada Okafor", "ada@example.com", "password123", "seeker", null);
  const amakaId = await seedUser("Amaka Chukwu", "amaka@example.com", "password123", "professional", "Trusted");
  const tundeId = await seedUser("Tunde Bakare", "tunde@example.com", "password123", "professional", "Rising");
  const femiId = await seedUser("Femi Adewale", "femi@example.com", "password123", "professional", "Rising");
  await seedUser("Admin", "admin@example.com", "adminpass123", "admin", null);

  async function seedProperty(owner, title, location, lat, lng, priceValue, beds, baths, tag, verification, amenities, description, gradientSeed, photoUrl) {
    const { lastInsertRowid } = await run(
      `INSERT INTO properties (owner_id, title, location, lat, lng, price_value, period, beds, baths, tag, status, verified, verify_identity, verify_property, verify_location, amenities, description, gradient_seed, cover_image_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '/year', ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        owner, title, location, lat, lng, priceValue, beds, beds, tag,
        verification.identity && verification.property ? 1 : 0,
        verification.identity ? 1 : 0, verification.property ? 1 : 0, verification.location ? 1 : 0,
        JSON.stringify(amenities), description, gradientSeed, photoUrl || null, t0,
      ]
    );
    return lastInsertRowid;
  }

  const p1 = await seedProperty(amakaId, "3-bed terrace, Osapa London", "Lekki, Lagos", 6.4478, 3.4726, 4.2, 3, 3, "Just listed",
    { identity: true, property: true, location: true }, ["parking", "generator", "security", "gated"],
    "A well-finished 3-bedroom terrace house in a gated estate in Osapa London, Lekki. Steady power via estate generator, borehole water, and dedicated parking for two cars.", "amber",
    "https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=900&q=80");

  await seedProperty(tundeId, "2-bed flat, off Awolowo Way", "Ikeja, Lagos", 6.6018, 3.3515, 2.6, 2, 2, "Price drop",
    { identity: true, property: true, location: false }, ["serviced", "water", "parking"],
    "Serviced 2-bedroom flat with reliable water supply, five minutes' walk from the Ikeja bus terminal.", "green",
    "https://images.unsplash.com/photo-1493809842364-78817add7ffb?w=900&q=80");

  await seedProperty(tundeId, "Studio, Herbert Macaulay Rd", "Yaba, Lagos", 6.5158, 3.3707, 1.4, 1, 1, "New",
    { identity: true, property: false, location: false }, ["water", "furnished"],
    "Furnished studio apartment close to Yaba's tech hub cluster. Awaiting property-level verification.", "rose",
    "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=900&q=80");

  const p4 = await seedProperty(amakaId, "4-bed duplex, Omole Phase 2", "Ojodu, Lagos", 6.6459, 3.3745, 5.8, 4, 4, "Verified",
    { identity: true, property: true, location: true }, ["generator", "water", "security", "garden"],
    "Spacious 4-bedroom duplex in a quiet residential estate with a private garden, backup generator, and borehole.", "blue",
    "https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=900&q=80");

  await seedProperty(femiId, "3-bed bungalow, Gwarinpa", "Gwarinpa, Abuja", 9.1084, 7.4165, 3.0, 3, 2, "New",
    { identity: true, property: true, location: true }, ["water", "security", "parking"],
    "Newly built bungalow in a quiet Gwarinpa close, walking distance to the estate's shopping plaza.", "green",
    "https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=900&q=80");

  await run("INSERT INTO requests (user_id, description, budget, location, beds, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)",
    [adaId, "2-bed near Yaba, under ₦2.5m, good water pressure", 2.5, "yaba", 2, t0]);

  async function seedLead(propertyId, fromUserId, name, message, status) {
    await run("INSERT INTO leads (property_id, from_user_id, name, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [propertyId, fromUserId, name, message, status, t0]);
  }
  await seedLead(p1, adaId, "Bode Alabi", "Is this still available? I'd like to view this weekend.", "New");
  await seedLead(p4, adaId, "Chiamaka Nwosu", "Interested — can we discuss agency fees?", "Contacted");
  await seedLead(p1, adaId, "Ifeanyi Obi", "Deal closed after viewing.", "Closed");

  // A real conversation thread + messages, so messaging isn't empty on first login.
  const { lastInsertRowid: convId } = await run("INSERT INTO conversations (property_id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)", [p1, adaId, amakaId, t0]);
  await run("INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)", [convId, adaId, "Hi! Is the Osapa London terrace still available?", t0]);
  await run("INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)", [convId, amakaId, "Yes it is — happy to arrange a viewing this weekend.", t0 + 1000]);

  // Social content — real rows, not front-end mocks.
  async function seedPost(authorId, type, caption, propertyId, mediaUrl) {
    const { lastInsertRowid } = await run("INSERT INTO posts (author_id, type, caption, property_id, media_url, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
      [authorId, type, caption, propertyId || null, mediaUrl || null, t0]);
    return lastInsertRowid;
  }
  const s1 = await seedPost(amakaId, "short", "What ₦4.2m/year actually gets you in Lekki right now", p1, null);
  const s2 = await seedPost(tundeId, "short", "Inside a newly finished duplex in Omole before it's listed", p4, null);
  const s3 = await seedPost(femiId, "short", "3 questions to ask before you pay agency fees", null, null);
  await seedPost(amakaId, "post", "Just closed on the Osapa London terrace — grateful for a smooth transaction!", p1, null);

  // ON CONFLICT/OR IGNORE differ by dialect — swallow duplicate-key errors instead.
  async function seedLike(postId, userId) {
    try { await run("INSERT INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)", [postId, userId, t0]); } catch {}
  }
  await seedLike(s1, adaId); await seedLike(s1, tundeId); await seedLike(s2, adaId); await seedLike(s3, adaId);

  await run("INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)", [s1, adaId, "This is exactly my budget range, thank you!", t0]);

  async function seedFollow(followerId, followeeId) {
    try { await run("INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)", [followerId, followeeId, t0]); } catch {}
  }
  await seedFollow(adaId, amakaId); await seedFollow(adaId, tundeId); await seedFollow(tundeId, amakaId);

  console.log("Seed complete.");
  console.log(`  users: 5, properties: 5, requests: 1, leads: 3, posts: 4, conversations: 1 (2 messages)`);
  console.log("\nTest accounts (password: password123, admin: adminpass123):");
  console.log("  seeker       ada@example.com");
  console.log("  professional amaka@example.com");
  console.log("  professional tunde@example.com");
  console.log("  professional femi@example.com");
  console.log("  admin        admin@example.com");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
