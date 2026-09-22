import { createClient } from "@supabase/supabase-js";

const userUrl = import.meta.env.VITE_USER_SUPABASE_URL || import.meta.env.VITE_SUPABASE_URL || "";
const userKey = import.meta.env.VITE_USER_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const mokioUrl = import.meta.env.VITE_MOKIO_SUPABASE_URL || "";
const mokioKey = import.meta.env.VITE_MOKIO_SUPABASE_ANON_KEY || "";

export const users = createClient(userUrl, userKey, {
  auth: { persistSession: true, storageKey: "mokio-users" },
});

export const mokio = createClient(mokioUrl || userUrl, mokioKey || userKey, {
  auth: { persistSession: true, storageKey: "mokio-msg" },
});

export const supabase = users;
