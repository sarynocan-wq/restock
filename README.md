# Restock

A shared grocery list and home inventory for two phones.

- **Home**: walk the house and mark items Have / Low / Out / Skip, or count them exactly
- **List**: sorted by the aisles of the store you're in, with live sync between phones
- **Setup**: rooms, stores (one per location), aisle numbers, the household invite code

Plain HTML, CSS and JavaScript with no build step. Supabase provides the database, logins, live sync and photo storage.

## Files

| File | What it does |
|---|---|
| `index.html` | Page shell and bottom tabs |
| `app.css` | All styling |
| `app.js` | Screens and everything you tap |
| `db.js` | Talking to Supabase, the offline outbox, demo mode |
| `config.js` | Your Supabase URL and anon key |
| `sw.js` | Keeps the app loading with a weak signal |
| `supabase/schema.sql` | Database tables and security rules |

## Setup (one time)

1. **Supabase**: create a project, open **SQL Editor**, paste in `supabase/schema.sql` and run it.
2. **Supabase → Authentication → URL Configuration**: set the **Site URL** to the app's address (for example `https://<username>.github.io/restock/`), so email confirmation links come back to the app.
3. **config.js**: fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Never use the service_role key here.
4. **GitHub Pages**: repo **Settings → Pages**, deploy from branch `main`, folder `/ (root)`.
5. On each phone, open the address in Chrome and use **⋮ → Add to Home screen**.
6. The first person creates an account, then picks **Create our home**. The second person creates an account, then picks **Join a home** with the invite code shown in Setup.

## Demo mode

With `config.js` left empty, the app runs on one device with sample data. This is handy for trying changes.

## Updating

After changing files, bump `CACHE` in `sw.js` (for example `restock-v2`), so phones pick up the new version.

## Roadmap

- Phase 2: barcode scanning (add products, check an item in the store, mark an empty as Out)
- Phase 3: learn each store's order from the order you tick items off
- Phase 4: sale lookups (Flipp search button)
