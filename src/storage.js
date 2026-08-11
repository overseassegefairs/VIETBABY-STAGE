import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill in your Supabase project's values."
  );
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Mimics the Claude-artifact window.storage API (get/set/delete/list) on top of
// a single Supabase table `kv_store(key text primary key, value jsonb)`.
// The app's original code always passed shared=true, so the `shared` param is
// accepted for compatibility but ignored — everything here is shared by nature.

async function get(key) {
  const { data, error } = await supabase
    .from("kv_store")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { key, value: JSON.stringify(data.value) };
}

async function set(key, value) {
  const parsed = JSON.parse(value);
  const { error } = await supabase
    .from("kv_store")
    .upsert({ key, value: parsed, updated_at: new Date().toISOString() });
  if (error) throw error;
  return { key, value };
}

async function del(key) {
  const { error } = await supabase.from("kv_store").delete().eq("key", key);
  if (error) throw error;
  return { key, deleted: true };
}

async function list(prefix) {
  let query = supabase.from("kv_store").select("key");
  if (prefix) query = query.like("key", `${prefix}%`);
  const { data, error } = await query;
  if (error) throw error;
  return { keys: (data || []).map((r) => r.key), prefix };
}

window.storage = { get, set, delete: del, list };

// Real-time sync: notifies `onChange` whenever the `applications` row changes
// in Supabase (from any browser — admin actions, new submissions, etc).
// Requires the table to be added to the `supabase_realtime` publication —
// see README section 1 for the one-line SQL command.
export function subscribeApplications(onChange) {
  const channel = supabase
    .channel("kv_store_applications")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "kv_store", filter: "key=eq.applications" },
      (payload) => onChange(payload)
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}
