// Supabase connection. The project is its own: "ideas-lab" (eu-central-1), not the calendar's project.
// The publishable key is meant for browsers and is safe to be public: every row is locked to its owner by
// row-level security in the database. It is the new-style publishable key (sb_publishable_...), not an anon JWT.
export const SUPABASE_URL = 'https://yqyctwgwhtezunsxxbcx.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_R3H2yM6tpbFddh44I8_x1w_7VgdgvDQ';

// The one account that can sign in to this project. Not a real mailbox: the code is public, so a personal
// address doesn't belong here. The user must exist in the ideas-lab project (Authentication > Users);
// the password itself lives only in Tal's password vault.
export const LOGIN_EMAIL = 'tal@ideas-lab.local';

// The saved sign-in lives under its own storage key on this device.
export const AUTH_STORAGE_KEY = 'ideas-lab-auth';

// The "agent last ran" line turns into a warning after this many hours without a new report.
export const AGENT_STALE_HOURS = 48;
