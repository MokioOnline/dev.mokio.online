import { mokio, users } from "./supabase";
import type { Bootstrap, Conversation, Message, Profile, Server } from "./types";

function nid() {
  return crypto.randomUUID();
}

function mapProfile(r: Record<string, unknown>, self = false): Profile {
  const hidden = Boolean(r.hide_online) || r.status === "invisible";
  return {
    userId: String(r.user_id),
    username: String(r.username),
    displayName: String(r.display_name),
    bio: String(r.bio || ""),
    pronouns: String(r.pronouns || ""),
    color: String(r.color || "#4fc3f7"),
    bannerColor: String(r.banner_color || "#12141c"),
    avatarUrl: (r.avatar_url as string) || null,
    bannerUrl: (r.banner_url as string) || null,
    status: (self ? r.status : hidden ? "offline" : r.status) as Profile["status"],
    phone: self ? String(r.phone || "") : "",
    email: self ? String(r.email || "") : "",
    hideOnline: self ? Boolean(r.hide_online) : false,
  };
}

const STAFF_ROLES = new Set(["owner", "dev", "tester"]);

export async function staffAccess() {
  const { data: userData } = await users.auth.getUser();
  const user = userData.user;
  if (!user) return { ok: false, role: null as string | null };
  let role: string | null = null;
  const byId = await users.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (byId.data?.role) role = byId.data.role as string;
  if (!role) {
    const byUid = await users.from("profiles").select("role").eq("user_id", user.id).maybeSingle();
    if (byUid.data?.role) role = byUid.data.role as string;
  }
  role = role || "pending";
  return { ok: STAFF_ROLES.has(role), role };
}

export async function connectMessaging(email: string, password: string) {
  const { data: userData } = await users.auth.getUser();
  const accountId = userData.user?.id;
  let { error } = await mokio.auth.signInWithPassword({ email: email.trim(), password });
  if (error) {
    const created = await mokio.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { account_id: accountId } },
    });
    if (created.error) {
      const retry = await mokio.auth.signInWithPassword({ email: email.trim(), password });
      if (retry.error) throw retry.error;
    }
  }
  if (accountId) {
    await mokio.rpc("mokio_link_account", { p_account_id: accountId });
  }
}

export async function linkAccount() {
  const { data: userData } = await users.auth.getUser();
  const { data, error } = await mokio.rpc("mokio_link_account", {
    p_account_id: userData.user?.id || null,
  });
  if (error) throw error;
  return String(data);
}

async function myId() {
  const { data, error } = await mokio.rpc("mokio_my_id");
  if (error) throw error;
  if (data) return String(data);
  return linkAccount();
}

async function profilesByIds(ids: string[], selfId: string) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [] as Profile[];
  const { data } = await mokio.from("mokio_profiles").select("*").in("user_id", unique);
  return (data || []).map((r) => mapProfile(r, r.user_id === selfId));
}

export async function loadBootstrap(): Promise<Bootstrap> {
  const access = await staffAccess();
  if (!access.ok) throw new Error("NO_ACCESS");
  const meId = await linkAccount();
  await mokio.from("mokio_presence").upsert({ user_id: meId, last_seen: new Date().toISOString(), status: "online" });
  const { data: meRow } = await mokio.from("mokio_profiles").select("*").eq("user_id", meId).single();
  if (!meRow) throw new Error("Profile missing");
  const me = mapProfile(meRow, true);

  const { data: fr } = await mokio
    .from("mokio_friendships")
    .select("*")
    .or(`requester_id.eq.${meId},addressee_id.eq.${meId}`);
  const friendRows = fr || [];
  const accepted = friendRows.filter((f) => f.status === "accepted");
  const incomingIds = friendRows.filter((f) => f.status === "pending" && f.addressee_id === meId).map((f) => f.requester_id as string);
  const outgoingIds = friendRows.filter((f) => f.status === "pending" && f.requester_id === meId).map((f) => f.addressee_id as string);
  const friendIds = accepted.map((f) => (f.requester_id === meId ? f.addressee_id : f.requester_id) as string);

  const { data: sm } = await mokio.from("mokio_server_members").select("server_id").eq("user_id", meId);
  const serverIds = (sm || []).map((r) => r.server_id as string);
  let servers: Server[] = [];
  if (serverIds.length) {
    const { data: srows } = await mokio.from("mokio_servers").select("*").in("id", serverIds);
    const { data: ch } = await mokio.from("mokio_channels").select("*").in("server_id", serverIds);
    const { data: mem } = await mokio.from("mokio_server_members").select("*").in("server_id", serverIds);
    const memPeople = await profilesByIds((mem || []).map((m) => m.user_id as string), meId);
    const memMap = Object.fromEntries(memPeople.map((p) => [p.userId, p]));
    servers = (srows || []).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      welcome: s.welcome,
      color: s.color,
      accent: s.accent,
      bannerColor: s.banner_color,
      iconUrl: s.icon_url,
      bannerUrl: s.banner_url,
      ownerId: s.owner_id,
      channels: (ch || [])
        .filter((c) => c.server_id === s.id)
        .map((c) => ({ id: c.id, serverId: c.server_id, name: c.name, type: c.type, topic: c.topic })),
      members: (mem || []).filter((m) => m.server_id === s.id).map((m) => memMap[m.user_id as string]).filter(Boolean),
    }));
  }

  const { data: convMem } = await mokio.from("mokio_conversation_members").select("conversation_id").eq("user_id", meId);
  const convIds = (convMem || []).map((r) => r.conversation_id as string);
  let conversations: Conversation[] = [];
  if (convIds.length) {
    const { data: convos } = await mokio.from("mokio_conversations").select("*").in("id", convIds);
    const { data: cm } = await mokio.from("mokio_conversation_members").select("*").in("conversation_id", convIds);
    const cpeople = await profilesByIds((cm || []).map((m) => m.user_id as string), meId);
    const cmap = Object.fromEntries(cpeople.map((p) => [p.userId, p]));
    conversations = (convos || []).map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      ownerId: c.owner_id,
      members: (cm || []).filter((m) => m.conversation_id === c.id).map((m) => cmap[m.user_id as string]).filter(Boolean),
    }));
  }

  const people = await profilesByIds([...friendIds, ...incomingIds, ...outgoingIds, meId], meId);
  const byId = Object.fromEntries(people.map((p) => [p.userId, p]));
  const { data: notif } = await mokio.from("mokio_notifications").select("*").eq("user_id", meId).order("created_at", { ascending: false }).limit(40);

  return {
    me,
    friends: accepted
      .map((f) => {
        const id = (f.requester_id === meId ? f.addressee_id : f.requester_id) as string;
        return byId[id] ? { user: byId[id], since: String(f.created_at) } : null;
      })
      .filter(Boolean) as Bootstrap["friends"],
    incoming: incomingIds.map((id) => byId[id]).filter(Boolean),
    outgoing: outgoingIds.map((id) => byId[id]).filter(Boolean),
    servers,
    conversations,
    notifications: (notif || []).map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      read: Boolean(n.read),
      createdAt: String(n.created_at),
    })),
    people,
  };
}

export async function updateProfile(patch: Partial<Profile>) {
  const meId = await myId();
  const row: Record<string, unknown> = {};
  if (patch.displayName !== undefined) row.display_name = patch.displayName.slice(0, 32);
  if (patch.username !== undefined) row.username = patch.username.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 18);
  if (patch.bio !== undefined) row.bio = patch.bio.slice(0, 180);
  if (patch.pronouns !== undefined) row.pronouns = patch.pronouns.slice(0, 32);
  if (patch.color !== undefined) row.color = patch.color;
  if (patch.bannerColor !== undefined) row.banner_color = patch.bannerColor;
  if (patch.avatarUrl !== undefined) row.avatar_url = patch.avatarUrl;
  if (patch.bannerUrl !== undefined) row.banner_url = patch.bannerUrl;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.phone !== undefined) row.phone = patch.phone.slice(0, 24);
  if (patch.email !== undefined) row.email = patch.email.slice(0, 120);
  if (patch.hideOnline !== undefined) row.hide_online = patch.hideOnline;
  if (Object.keys(row).length) await mokio.from("mokio_profiles").update(row).eq("user_id", meId);
}

export async function addFriend(username: string) {
  const meId = await myId();
  const { data: target } = await mokio.from("mokio_profiles").select("*").ilike("username", username.trim()).maybeSingle();
  if (!target) throw new Error("No user with that username.");
  if (target.user_id === meId) throw new Error("That's you.");
  const { data: existing } = await mokio
    .from("mokio_friendships")
    .select("*")
    .or(`and(requester_id.eq.${meId},addressee_id.eq.${target.user_id}),and(requester_id.eq.${target.user_id},addressee_id.eq.${meId})`)
    .maybeSingle();
  if (existing?.status === "accepted") throw new Error("Already friends.");
  if (existing?.status === "pending" && existing.addressee_id === meId) {
    await mokio.from("mokio_friendships").update({ status: "accepted" }).eq("requester_id", target.user_id).eq("addressee_id", meId);
    return;
  }
  if (existing) throw new Error("Request already sent.");
  await mokio.from("mokio_friendships").insert({ requester_id: meId, addressee_id: target.user_id, status: "pending" });
  const me = (await mokio.from("mokio_profiles").select("display_name").eq("user_id", meId).single()).data;
  await mokio.from("mokio_notifications").insert({
    id: nid(),
    user_id: target.user_id,
    type: "friend",
    title: "Friend request",
    body: `${me?.display_name || "Someone"} wants to be friends`,
    from_user_id: meId,
  });
}

export async function respondFriend(userId: string, accept: boolean) {
  const meId = await myId();
  if (accept) {
    await mokio.from("mokio_friendships").update({ status: "accepted" }).eq("requester_id", userId).eq("addressee_id", meId);
  } else {
    await mokio.from("mokio_friendships").delete().eq("requester_id", userId).eq("addressee_id", meId);
  }
}

export async function openDm(userId: string) {
  const meId = await myId();
  const { data: mine } = await mokio.from("mokio_conversation_members").select("conversation_id").eq("user_id", meId);
  const ids = (mine || []).map((r) => r.conversation_id as string);
  if (ids.length) {
    const { data: theirs } = await mokio.from("mokio_conversation_members").select("conversation_id").eq("user_id", userId).in("conversation_id", ids);
    if (theirs?.[0]) {
      const { data: c } = await mokio.from("mokio_conversations").select("*").eq("id", theirs[0].conversation_id).eq("kind", "dm").maybeSingle();
      if (c) return c.id as string;
    }
  }
  const id = nid();
  await mokio.from("mokio_conversations").insert({ id, kind: "dm" });
  await mokio.from("mokio_conversation_members").insert([
    { conversation_id: id, user_id: meId },
    { conversation_id: id, user_id: userId },
  ]);
  return id;
}

export async function createGroup(name: string, memberIds: string[]) {
  const meId = await myId();
  const ids = [...new Set([meId, ...memberIds])];
  if (ids.length < 3) throw new Error("Pick at least two friends.");
  const id = nid();
  await mokio.from("mokio_conversations").insert({ id, kind: "group", name: name.slice(0, 40), owner_id: meId });
  await mokio.from("mokio_conversation_members").insert(ids.map((user_id) => ({ conversation_id: id, user_id })));
  return id;
}

export async function createServer(name: string) {
  const meId = await myId();
  const id = nid();
  const n = name.slice(0, 40) || "Server";
  await mokio.from("mokio_servers").insert({
    id,
    name: n,
    welcome: `Welcome to ${n}`,
    owner_id: meId,
  });
  await mokio.from("mokio_server_members").insert({ server_id: id, user_id: meId });
  await mokio.from("mokio_channels").insert([
    { id: nid(), server_id: id, name: "general", type: "text", topic: "Say hello" },
    { id: nid(), server_id: id, name: "Lobby", type: "voice", topic: "" },
  ]);
  return id;
}

export async function updateServer(patch: { id: string; name?: string; description?: string; welcome?: string; color?: string; accent?: string; bannerColor?: string; iconUrl?: string | null; bannerUrl?: string | null }) {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.welcome !== undefined) row.welcome = patch.welcome;
  if (patch.color !== undefined) row.color = patch.color;
  if (patch.accent !== undefined) row.accent = patch.accent;
  if (patch.bannerColor !== undefined) row.banner_color = patch.bannerColor;
  if (patch.iconUrl !== undefined) row.icon_url = patch.iconUrl;
  if (patch.bannerUrl !== undefined) row.banner_url = patch.bannerUrl;
  await mokio.from("mokio_servers").update(row).eq("id", patch.id);
}

export async function addServerMember(serverId: string, username: string) {
  const { data: target } = await mokio.from("mokio_profiles").select("user_id").ilike("username", username.trim()).maybeSingle();
  if (!target) throw new Error("No user with that username.");
  await mokio.from("mokio_server_members").insert({ server_id: serverId, user_id: target.user_id });
}

export async function createChannel(serverId: string, name: string, type: "text" | "voice") {
  const id = nid();
  await mokio.from("mokio_channels").insert({ id, server_id: serverId, name: name.slice(0, 32) || "chat", type, topic: "" });
  return id;
}

export async function deleteChannel(channelId: string) {
  await mokio.from("mokio_messages").delete().eq("channel_id", channelId);
  await mokio.from("mokio_channels").delete().eq("id", channelId);
}

export async function listMessages(opts: { channelId?: string | null; conversationId?: string | null }): Promise<Message[]> {
  let q = mokio.from("mokio_messages").select("*").order("created_at", { ascending: true }).limit(200);
  if (opts.channelId) q = q.eq("channel_id", opts.channelId);
  else if (opts.conversationId) q = q.eq("conversation_id", opts.conversationId);
  else return [];
  const { data } = await q;
  return (data || []).map((m) => ({
    id: m.id,
    channelId: m.channel_id,
    conversationId: m.conversation_id,
    authorId: m.author_id,
    content: m.content,
    gifUrl: m.gif_url,
    createdAt: String(m.created_at),
  }));
}

export async function sendMessage(opts: { channelId?: string | null; conversationId?: string | null; content: string; gifUrl?: string | null }) {
  const meId = await myId();
  const row = {
    id: nid(),
    channel_id: opts.channelId || null,
    conversation_id: opts.conversationId || null,
    author_id: meId,
    content: opts.content.slice(0, 1000),
    gif_url: opts.gifUrl || null,
  };
  await mokio.from("mokio_messages").insert(row);
  return {
    id: row.id,
    channelId: row.channel_id,
    conversationId: row.conversation_id,
    authorId: meId,
    content: row.content,
    gifUrl: row.gif_url,
    createdAt: new Date().toISOString(),
  } satisfies Message;
}

export async function markNotificationsRead() {
  const meId = await myId();
  await mokio.from("mokio_notifications").update({ read: true }).eq("user_id", meId);
}

export async function inviteToCall(userIds: string[], label: string) {
  const meId = await myId();
  const roomId = nid();
  const rows = userIds.filter((id) => id !== meId).map((to_id) => ({
    id: nid(),
    room_id: roomId,
    label,
    from_id: meId,
    to_id,
  }));
  if (rows.length) await mokio.from("mokio_call_invites").insert(rows);
  return roomId;
}

export { myId, nid };
