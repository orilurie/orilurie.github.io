# שרת "זירה"

שרת המשחק של זירה (`game-night/arena.html`), שרץ ב־Cloudflare Workers + Durable Objects:
https://arena.hathatul.workers.dev

- `src/index.js`: חדר משחק (Durable Object לכל חדר, 30 טיקים בשנייה), Matchmaker ל"משחק מהיר", ובוטים.
- הסימולציה המשותפת לשרת ולדפדפן: `../game-night/arena-core.js`.

העלאה (מהתיקייה הזו):

```
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy
```

בדיקה מקומית: `npx wrangler dev --port 8787`, ואז לפתוח `game-night/arena.html?server=http://localhost:8787`.
