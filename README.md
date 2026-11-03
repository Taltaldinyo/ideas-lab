# Ideas Lab (מעבדת רעיונות)

A personal tool of Tal, not a product for others: write an idea in one line, get a structured report, then decide to build it or drop it.
Plain HTML, CSS and JavaScript (no build step), Hebrew and right-to-left, made to be used from a phone.
It talks to one Supabase project; every row is locked to the single account that can sign in (row-level security), and sign-up is off.
No secret is stored in this repository. The `sb_publishable_...` key in `config.js` is public on purpose: it is meant for browsers and gives no access without signing in.
The password, the agent tokens and the service key live outside the code, in a password manager and in Supabase's own secret store.
Local preview: serve this folder with any static server and open `/?demo` on localhost for sample data (no sign-in, no database).
