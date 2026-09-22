/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USER_SUPABASE_URL: string;
  readonly VITE_USER_SUPABASE_ANON_KEY: string;
  readonly VITE_MOKIO_SUPABASE_URL: string;
  readonly VITE_MOKIO_SUPABASE_ANON_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
