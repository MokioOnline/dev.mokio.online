import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase, mokio, users } from "./lib/supabase";
import * as api from "./lib/api";
import type { Bootstrap, Conversation, Message, Profile, Server, Status } from "./lib/types";
import {
  Bell,
  Check,
  GripHorizontal,
  Hash,
  Mic,
  MicOff,
  MonitorUp,
  Paperclip,
  Phone,
  PhoneOff,
  Plus,
  Send,
  Settings,
  Smile,
  UserPlus,
  Users,
  Video,
  VideoOff,
  Volume2,
  X,
} from "lucide-react";
import {
  getVoiceLocal,
  getVoicePeers,
  getVoiceRemotes,
  getVoiceRoom,
  getVoiceScreen,
  hangUp,
  hasCamera,
  isMuted,
  isScreenTrack,
  isSharingScreen,
  joinVoice,
  onVoiceChange,
  shareVoiceScreen,
  toggleVoiceCamera,
  toggleVoiceMute,
} from "./lib/voice";

const LIMIT = 1000;
const EMOJI = ["😀","😂","😍","🥰","😎","🤔","😭","😡","👍","👎","👏","🙌","🔥","✨","💯","❤️","💜","💙","🎉","🎊","🙏","👀","💀","✅","⭐","🌙","☀️","🌈","🐶","🐱","🍕","☕"];
const GIFS = [
  { id: "wave", label: "Wave", url: "https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif" },
  { id: "up", label: "Thumbs up", url: "https://media.giphy.com/media/111ebonMs90YLu/giphy.gif" },
  { id: "clap", label: "Clap", url: "https://media.giphy.com/media/7rj2ZgttvgomY/giphy.gif" },
  { id: "lol", label: "LOL", url: "https://media.giphy.com/media/10JhviFuU2gWD6/giphy.gif" },
  { id: "party", label: "Party", url: "https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif" },
  { id: "wow", label: "Wow", url: "https://media.giphy.com/media/5VKbvrjxpVJKE/giphy.gif" },
];

function playBeep(freq = 880, ms = 180) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.04, ctx.currentTime);
    o.start();
    o.stop(ctx.currentTime + ms / 1000);
  } catch {}
}

function Avatar({ name, src, color, size = 36 }: { name: string; src?: string | null; color?: string; size?: number }) {
  return src ? (
    <img src={src} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <div
      className="grid shrink-0 place-items-center rounded-full text-xs font-semibold"
      style={{ width: size, height: size, background: color || "#4fc3f7", color: "#071018" }}
    >
      {(name || "?").slice(0, 1).toUpperCase()}
    </div>
  );
}

function StatusDot({ status }: { status: Status }) {
  const c = status === "online" ? "bg-success" : status === "dnd" ? "bg-danger" : "bg-subtle";
  return <span className={`inline-block size-2 rounded-full ${c}`} />;
}

function readFileAsData(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function App() {
  const [session, setSession] = useState<{ access_token: string } | null>(null);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [authErr, setAuthErr] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [panel, setPanel] = useState<"friends" | "chat" | "voice" | "settings" | "notifications" | "server">("friends");
  const [serverId, setServerId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [picker, setPicker] = useState(false);
  const [notice, setNotice] = useState("");
  const [incoming, setIncoming] = useState<{ roomId: string; label: string; fromName: string } | null>(null);
  const [newServer, setNewServer] = useState(false);
  const [serverName, setServerName] = useState("");
  const [groupStep, setGroupStep] = useState<0 | 1 | 2>(0);
  const [groupName, setGroupName] = useState("");
  const [groupPicks, setGroupPicks] = useState<string[]>([]);
  const [addFriend, setAddFriend] = useState("");
  const [addMember, setAddMember] = useState("");
  const [addChannel, setAddChannel] = useState<"text" | "voice" | null>(null);
  const [channelName, setChannelName] = useState("");
  const [, bump] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File[]>([]);
  const [denied, setDenied] = useState(false);
  const [deniedRole, setDeniedRole] = useState("");
  useEffect(() => onVoiceChange(() => bump((n) => n + 1)), []);

  const refresh = useCallback(async () => {
    const access = await api.staffAccess();
    if (!access.ok) {
      setDenied(true);
      setDeniedRole(access.role || "pending");
      setData(null);
      return null;
    }
    setDenied(false);
    const b = await api.loadBootstrap();
    setData(b);
    return b;
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: d }) => setSession(d.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, sess) => setSession(sess));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) {
      setData(null);
      setDenied(false);
      return;
    }
    refresh().catch((e) => {
      const msg = e instanceof Error ? e.message : "Could not load";
      if (msg === "NO_ACCESS" || /only open to testers/i.test(msg)) {
        setDenied(true);
        return;
      }
      setAuthErr(msg);
    });
    const t = window.setInterval(() => {
      refresh().catch(() => {});
    }, 4000);
    return () => window.clearInterval(t);
  }, [session?.access_token, refresh]);

  useEffect(() => {
    if (!channelId && !conversationId) return;
    api.listMessages({ channelId, conversationId }).then(setMessages).catch(() => setMessages([]));
  }, [channelId, conversationId]);

  useEffect(() => {
    if (!data?.me.userId) return;
    const ch = mokio
      .channel("mokio-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "mokio_messages" }, (payload) => {
        const r = payload.new as { id: string; channel_id: string | null; conversation_id: string | null; author_id: string; content: string; gif_url: string | null; created_at: string };
        const m: Message = {
          id: r.id,
          channelId: r.channel_id,
          conversationId: r.conversation_id,
          authorId: r.author_id,
          content: r.content,
          gifUrl: r.gif_url,
          createdAt: r.created_at,
        };
        if ((m.channelId && m.channelId === channelId) || (m.conversationId && m.conversationId === conversationId)) {
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
        } else if (data.me.status !== "dnd") playBeep();
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "mokio_call_invites", filter: `to_id=eq.${data.me.userId}` }, (payload) => {
        const r = payload.new as { room_id: string; label: string; from_id: string };
        if (data.me.status === "dnd") return;
        setIncoming({ roomId: r.room_id, label: r.label, fromName: "Incoming call" });
        playBeep(640, 400);
      })
      .subscribe();
    return () => {
      void mokio.removeChannel(ch);
    };
  }, [data?.me.userId, data?.me.status, channelId, conversationId]);

  const me = data?.me;
  const server = data?.servers.find((x) => x.id === serverId);
  const channel = server?.channels.find((c) => c.id === channelId);
  const conversation = data?.conversations.find((c) => c.id === conversationId);
  const people = useMemo(() => {
    const map: Record<string, Profile> = {};
    data?.people.forEach((p) => { map[p.userId] = p; });
    if (data?.me) map[data.me.userId] = data.me;
    return map;
  }, [data]);

  async function auth(kind: "login" | "register") {
    setAuthErr("");
    try {
      if (kind === "register") {
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { name: displayName || email.split("@")[0] } },
        });
        if (error) throw error;
        await api.connectMessaging(email.trim(), password);
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        await api.connectMessaging(email.trim(), password);
      }
    } catch (e) {
      setAuthErr(e instanceof Error ? e.message : "Could not sign in");
    }
  }

  async function send(gifUrl?: string) {
    const content = text.trim();
    if (!content && !gifUrl && !pending.length) return;
    if (text.length > LIMIT) return;
    let extra = gifUrl || null;
    if (pending[0] && pending[0].type.startsWith("image/")) {
      extra = await readFileAsData(pending[0]);
    }
    const msg = await api.sendMessage({ channelId, conversationId, content, gifUrl: extra });
    setMessages((m) => [...m, msg]);
    setText("");
    setPending([]);
    setPicker(false);
  }

  async function openDm(userId: string) {
    try {
      const id = await api.openDm(userId);
      setConversationId(id);
      setChannelId(null);
      setServerId(null);
      setPanel("chat");
      await refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not open chat");
    }
  }

  async function startCall(userIds: string[], label: string) {
    const roomId = await api.inviteToCall(userIds, label);
    if (data?.me.userId) void joinVoice(null, data.me.userId, roomId, label);
    setPanel("voice");
  }

  if (session && denied) {
    return (
      <div className="grid h-full place-items-center bg-bg p-6" style={{ backgroundImage: "url(/mokio-banner.jpg)", backgroundSize: "cover", backgroundPosition: "center" }}>
        <div className="w-full max-w-md rounded-2xl border border-border bg-bg/90 p-6 text-center shadow-2xl backdrop-blur">
          <img src="/mokio-logo.png" alt="Mokio" className="mx-auto mb-3 h-20 w-20 object-contain" />
          <h1 className="mb-2 text-2xl font-semibold">No access</h1>
          <p className="mb-1 text-sm text-muted">Mokio is only open to testers, developers, and owners.</p>
          <p className="mb-5 text-xs text-subtle">Your role: {deniedRole || "member"}</p>
          <button
            className="h-11 w-full rounded-lg bg-accent text-sm font-medium text-accent-fg"
            onClick={() => {
              void users.auth.signOut();
              void mokio.auth.signOut();
              setSession(null);
              setDenied(false);
              setData(null);
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="grid h-full place-items-center bg-bg p-6" style={{ backgroundImage: "url(/mokio-banner.jpg)", backgroundSize: "cover", backgroundPosition: "center" }}>
        <div className="w-full max-w-md rounded-2xl border border-border bg-bg/90 p-6 shadow-2xl backdrop-blur">
          <img src="/mokio-logo.png" alt="Mokio" className="mx-auto mb-3 h-20 w-20 object-contain" />
          <h1 className="mb-1 text-center text-2xl font-semibold">Mokio</h1>
          <p className="mb-5 text-center text-sm text-muted">Message and call in your browser.</p>
          <div className="mb-4 grid grid-cols-2 rounded-lg bg-elevated p-1">
            <button className={`rounded-md py-1.5 text-sm ${mode === "login" ? "bg-panel" : "text-muted"}`} onClick={() => setMode("login")}>Sign in</button>
            <button className={`rounded-md py-1.5 text-sm ${mode === "register" ? "bg-panel" : "text-muted"}`} onClick={() => setMode("register")}>Create account</button>
          </div>
          {mode === "register" && (
            <input className="mb-2 h-11 w-full rounded-lg border border-border bg-elevated px-3 text-sm outline-none" placeholder="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          )}
          <input className="mb-2 h-11 w-full rounded-lg border border-border bg-elevated px-3 text-sm outline-none" placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="mb-3 h-11 w-full rounded-lg border border-border bg-elevated px-3 text-sm outline-none" placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {authErr && <p className="mb-2 text-sm text-danger">{authErr}</p>}
          <button className="h-11 w-full rounded-lg bg-accent text-sm font-medium text-accent-fg" onClick={() => auth(mode)}>
            {mode === "login" ? "Enter Mokio" : "Create account"}
          </button>
          <button className="mt-2 h-11 w-full rounded-lg border border-border bg-elevated text-sm" onClick={() => void supabase.auth.signInWithOAuth({ provider: "google" })}>
            Continue with Google
          </button>
        </div>
      </div>
    );
  }

  const title = conversation
    ? conversation.kind === "group"
      ? conversation.name || "Group"
      : conversation.members.find((m) => m.userId !== me.userId)?.displayName || "Direct message"
    : channel?.name || "Chat";

  const room = getVoiceRoom();

  return (
    <div className="flex h-full bg-bg text-fg">
      <aside className="flex w-[72px] flex-col items-center gap-2 border-r border-border bg-bg py-3">
        <button onClick={() => { setPanel("friends"); setServerId(null); setChannelId(null); setConversationId(null); }} title="Home">
          <img src="/mokio-logo.png" alt="" className="h-12 w-12 rounded-2xl object-cover" />
        </button>
        <div className="h-px w-8 bg-border" />
        {data.servers.map((sv) => (
          <button
            key={sv.id}
            title={sv.name}
            onClick={() => {
              setServerId(sv.id);
              const first = sv.channels.find((c) => c.type === "text");
              setChannelId(first?.id || null);
              setConversationId(null);
              setPanel(first ? "chat" : "friends");
            }}
            className={`grid size-12 place-items-center overflow-hidden rounded-2xl ${serverId === sv.id ? "ring-2 ring-accent" : "bg-elevated"}`}
          >
            {sv.iconUrl ? <img src={sv.iconUrl} alt="" className="h-full w-full object-cover" /> : <span className="text-sm font-semibold">{sv.name.slice(0, 1)}</span>}
          </button>
        ))}
        <button className="grid size-12 place-items-center rounded-2xl bg-elevated text-accent" onClick={() => setNewServer(true)} title="New server">
          <Plus className="size-5" />
        </button>
      </aside>

      <aside className="flex w-60 flex-col border-r border-border bg-surface">
        <div className="flex h-12 items-center justify-between border-b border-border px-3">
          <span className="truncate font-medium">{server ? server.name : "Direct messages"}</span>
          {server?.ownerId === me.userId && (
            <button className="text-muted hover:text-fg" onClick={() => setPanel("server")}><Settings className="size-4" /></button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {!server && (
            <>
              <button className="mb-1 w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-elevated" onClick={() => setPanel("friends")}>Friends</button>
              {data.conversations.map((c) => (
                <button
                  key={c.id}
                  className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-elevated ${conversationId === c.id ? "bg-elevated" : ""}`}
                  onClick={() => { setConversationId(c.id); setChannelId(null); setServerId(null); setPanel("chat"); }}
                >
                  <Users className="size-4 text-muted" />
                  <span className="truncate">{c.kind === "group" ? c.name : c.members.find((m) => m.userId !== me.userId)?.displayName}</span>
                </button>
              ))}
            </>
          )}
          {server && (
            <>
              <div className="mb-1 mt-2 px-2 text-[11px] uppercase tracking-wide text-muted">Text</div>
              {server.channels.filter((c) => c.type === "text").map((c) => (
                <button key={c.id} className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-elevated ${channelId === c.id ? "bg-elevated" : ""}`} onClick={() => { setChannelId(c.id); setConversationId(null); setPanel("chat"); }}>
                  <Hash className="size-4 text-muted" /> {c.name}
                </button>
              ))}
              <div className="mb-1 mt-3 px-2 text-[11px] uppercase tracking-wide text-muted">Call lobbies</div>
              {server.channels.filter((c) => c.type === "voice").map((c) => (
                <button key={c.id} className="mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-elevated" onClick={() => { startCall(server.members.map((m) => m.userId), c.name); setPanel("voice"); }}>
                  <Volume2 className="size-4 text-muted" /> {c.name}
                </button>
              ))}
            </>
          )}
        </div>
        <button className="flex items-center gap-2 border-t border-border px-3 py-3 text-left hover:bg-elevated" onClick={() => setPanel("settings")}>
          <Avatar name={me.displayName} src={me.avatarUrl} color={me.color} size={32} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{me.displayName}</span>
            <span className="flex items-center gap-1 text-[11px] text-muted"><StatusDot status={me.status} /> {me.status}</span>
          </span>
        </button>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-surface">
        <header className="flex h-12 items-center gap-2 border-b border-border px-4">
          <span className="flex-1 truncate font-medium">{panel === "friends" ? "Friends" : panel === "settings" ? "Settings" : panel === "notifications" ? "Notifications" : panel === "server" ? "Server" : panel === "voice" ? room?.label || "Call" : title}</span>
          {(conversation || channel) && panel === "chat" && (
            <button className="rounded-md p-2 text-muted hover:bg-panel" title="Call" onClick={() => {
              const ids = conversation ? conversation.members.map((m) => m.userId) : server?.members.map((m) => m.userId) || [];
              startCall(ids, title);
              setPanel("voice");
            }}><Phone className="size-4" /></button>
          )}
          <button className="rounded-md p-2 text-muted hover:bg-panel" onClick={() => { setPanel("notifications"); void api.markNotificationsRead().then(() => refresh()); }}><Bell className="size-4" /></button>
        </header>

        {panel === "friends" && (
          <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto p-5">
            <form className="mb-4 flex gap-2" onSubmit={async (e) => { e.preventDefault(); try { await api.addFriend(addFriend); setNotice("Request sent."); await refresh(); } catch (err) { setNotice(err instanceof Error ? err.message : "Could not add"); } setAddFriend(""); }}>
              <input className="h-11 flex-1 rounded-lg border border-border bg-elevated px-3 text-sm" placeholder="Add a friend by username" value={addFriend} onChange={(e) => setAddFriend(e.target.value)} />
              <button className="inline-flex h-11 items-center gap-1 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg"><UserPlus className="size-4" /> Add</button>
            </form>
            {notice && <p className="mb-3 text-sm text-success">{notice}</p>}
            <button className="mb-5 flex w-full items-center gap-3 rounded-xl border border-border bg-elevated px-4 py-3" onClick={() => setGroupStep(1)}>
              <Users className="size-5 text-accent" />
              <span><span className="block text-sm font-medium">New group</span><span className="text-xs text-muted">Name it, then pick at least two friends.</span></span>
            </button>
            {data.incoming.length > 0 && (
              <section className="mb-5">
                <h2 className="mb-2 text-xs uppercase text-muted">Requests</h2>
                {data.incoming.map((p) => (
                  <div key={p.userId} className="flex items-center gap-3 rounded-lg px-2 py-2">
                    <Avatar name={p.displayName} src={p.avatarUrl} color={p.color} />
                    <div className="flex-1"><div className="text-sm">{p.displayName}</div><div className="text-xs text-muted">@{p.username}</div></div>
                    <button className="rounded-md bg-success p-2" onClick={() => void api.respondFriend(p.userId, true).then(() => refresh())}><Check className="size-4" /></button>
                    <button className="rounded-md bg-panel p-2" onClick={() => void api.respondFriend(p.userId, false).then(() => refresh())}><X className="size-4" /></button>
                  </div>
                ))}
              </section>
            )}
            <h2 className="mb-2 text-xs uppercase text-muted">Friends</h2>
            {data.friends.map((f) => (
              <div key={f.user.userId} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-elevated">
                <Avatar name={f.user.displayName} src={f.user.avatarUrl} color={f.user.color} />
                <button className="min-w-0 flex-1 text-left" onClick={() => openDm(f.user.userId)}>
                  <div className="flex items-center gap-2 text-sm">{f.user.displayName} <StatusDot status={f.user.status} /></div>
                  <div className="text-xs text-muted">@{f.user.username}</div>
                </button>
                <button className="rounded-md p-2 text-muted hover:bg-panel" onClick={() => openDm(f.user.userId)}><Users className="size-4" /></button>
                <button className="rounded-md p-2 text-muted hover:bg-panel" onClick={() => { startCall([f.user.userId], f.user.displayName); setPanel("voice"); }}><Phone className="size-4" /></button>
              </div>
            ))}
          </div>
        )}

        {panel === "chat" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {messages.map((msg, i) => {
                const prev = messages[i - 1];
                const burst = prev && prev.authorId === msg.authorId && Math.abs(new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime()) < 5 * 60 * 1000;
                const author = people[msg.authorId];
                const name = author?.displayName || "Someone";
                return (
                  <div key={msg.id} className={`flex gap-3 px-1 ${burst ? "mt-0.5 py-0.5" : "mt-3 py-1"}`}>
                    {burst ? <div className="w-9" /> : <Avatar name={name} src={author?.avatarUrl} color={author?.color} />}
                    <div className="min-w-0 flex-1">
                      {!burst && (
                        <div className="mb-0.5 flex items-baseline gap-2">
                          <span className="text-sm font-medium" style={{ color: author?.color }}>{name}</span>
                          <span className="text-[11px] text-subtle">{new Date(msg.createdAt).toLocaleString()}</span>
                        </div>
                      )}
                      {msg.content && <p className="whitespace-pre-wrap break-words text-[15px] leading-snug">{msg.content}</p>}
                      {msg.gifUrl && <img src={msg.gifUrl} alt="" className="mt-1 max-h-48 rounded-lg" />}
                      {msg.attachments?.map((a) => a.url.match(/\.(png|jpg|jpeg|gif|webp)$/i) ? <img key={a.url} src={a.url} alt="" className="mt-1 max-h-56 rounded-lg" /> : <a key={a.url} href={a.url} className="mt-1 block text-sm text-accent">{a.name}</a>)}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="relative px-4 pb-4">
              {picker && (
                <div className="absolute bottom-16 left-4 z-20 w-72 overflow-hidden rounded-xl border border-border bg-[#111318] p-2 shadow-2xl">
                  <div className="grid grid-cols-8 gap-1">
                    {EMOJI.map((g) => <button key={g} className="grid h-8 w-8 place-items-center rounded-md text-lg hover:bg-panel" onClick={() => setText((t) => (t + g).slice(0, LIMIT))}>{g}</button>)}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {GIFS.map((g) => <button key={g.id} onClick={() => void send(g.url)}><img src={g.url} alt={g.label} className="h-20 w-full rounded-md object-cover" /></button>)}
                  </div>
                </div>
              )}
              {pending.length > 0 && <div className="mb-2 text-xs text-muted">{pending.map((f) => f.name).join(", ")}</div>}
              <div className="flex items-end gap-2 rounded-xl border border-border bg-elevated px-3 py-2">
                <button className="p-1.5 text-muted" onClick={() => fileRef.current?.click()}><Paperclip className="size-5" /></button>
                <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => setPending([...e.target.files || []])} />
                <textarea value={text} maxLength={LIMIT} rows={1} placeholder={`Message ${title}`} className="max-h-32 min-h-10 flex-1 resize-none bg-transparent py-2 text-sm outline-none" onChange={(e) => setText(e.target.value.slice(0, LIMIT))} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
                <button className="p-1.5 text-muted" onClick={() => setPicker((v) => !v)}><Smile className="size-5" /></button>
                <span className={`mb-2 text-[11px] ${text.length > 900 ? "text-warn" : "text-subtle"}`}>{LIMIT - text.length}</span>
                <button className="rounded-md bg-accent p-2 text-accent-fg disabled:opacity-40" disabled={!text.trim() && !pending.length} onClick={() => void send()}><Send className="size-4" /></button>
              </div>
            </div>
          </div>
        )}

        {panel === "voice" && <VoiceStage />}

        {panel === "settings" && (
          <SettingsPane me={me} onSave={async (patch) => { await api.updateProfile(patch); await refresh(); }} onSignOut={() => { void users.auth.signOut(); void mokio.auth.signOut(); setSession(null); setData(null); void hangUp(); }} />
        )}

        {panel === "notifications" && (
          <div className="flex-1 overflow-y-auto p-4">
            {data.notifications.length === 0 && <p className="text-sm text-muted">No notifications.</p>}
            {data.notifications.map((n) => (
              <div key={n.id} className="mb-2 rounded-lg border border-border bg-elevated p-3">
                <div className="text-sm font-medium">{n.title}</div>
                <div className="text-sm text-muted">{n.body}</div>
              </div>
            ))}
          </div>
        )}

        {panel === "server" && server && (
          <ServerStudio
            server={server}
            me={me}
            addMember={addMember}
            setAddMember={setAddMember}
            addChannel={addChannel}
            setAddChannel={setAddChannel}
            channelName={channelName}
            setChannelName={setChannelName}
            onUpdate={(patch) => void api.updateServer({ id: server.id, ...patch }).then(() => refresh())}
            onAddMember={async () => { try { await api.addServerMember(server.id, addMember); setNotice("Added."); } catch (e) { setNotice(e instanceof Error ? e.message : "Could not add"); } setAddMember(""); await refresh(); }}
            onCreateChannel={async () => { if (!addChannel) return; await api.createChannel(server.id, channelName, addChannel); setAddChannel(null); setChannelName(""); await refresh(); }}
            onDeleteChannel={(id) => void api.deleteChannel(id).then(() => refresh())}
          />
        )}
      </main>

      {room && panel !== "voice" && <VoiceDock />}

      {incoming && (
        <div className="fixed inset-x-0 top-4 z-50 mx-auto flex w-[min(420px,calc(100%-24px))] items-center gap-3 rounded-2xl border border-border bg-elevated p-3 shadow-2xl">
          <Phone className="size-5 text-accent" />
          <div className="flex-1"><div className="text-sm font-medium">{incoming.fromName} is calling</div><div className="text-xs text-muted">{incoming.label}</div></div>
          <button className="rounded-md bg-success px-3 py-1.5 text-sm text-accent-fg" onClick={() => { void joinVoice(null, me.userId, incoming.roomId, incoming.label); setPanel("voice"); setIncoming(null); }}>Join</button>
          <button className="rounded-md bg-panel px-3 py-1.5 text-sm" onClick={() => setIncoming(null)}>Ignore</button>
        </div>
      )}

      {newServer && (
        <Modal onClose={() => setNewServer(false)} title="New server">
          <input className="mb-3 h-11 w-full rounded-lg border border-border bg-elevated px-3 text-sm" placeholder="Server name" value={serverName} onChange={(e) => setServerName(e.target.value)} />
          <button className="h-11 w-full rounded-lg bg-accent text-sm font-medium text-accent-fg" onClick={async () => { await api.createServer(serverName); setNewServer(false); setServerName(""); await refresh(); }}>Create</button>
        </Modal>
      )}

      {groupStep > 0 && (
        <Modal onClose={() => { setGroupStep(0); setGroupPicks([]); }} title={groupStep === 1 ? "Name your group" : "Pick friends"}>
          {groupStep === 1 ? (
            <>
              <input className="mb-3 h-11 w-full rounded-lg border border-border bg-elevated px-3 text-sm" placeholder="Group name" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
              <button className="h-11 w-full rounded-lg bg-accent text-sm font-medium text-accent-fg" disabled={!groupName.trim()} onClick={() => setGroupStep(2)}>Next</button>
            </>
          ) : (
            <>
              <div className="mb-3 max-h-56 space-y-1 overflow-y-auto">
                {data.friends.map((f) => {
                  const on = groupPicks.includes(f.user.userId);
                  return (
                    <button key={f.user.userId} className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left ${on ? "bg-panel" : "hover:bg-elevated"}`} onClick={() => setGroupPicks((p) => on ? p.filter((id) => id !== f.user.userId) : [...p, f.user.userId])}>
                      <Avatar name={f.user.displayName} src={f.user.avatarUrl} color={f.user.color} size={28} />
                      <span className="flex-1 text-sm">{f.user.displayName}</span>
                      {on && <Check className="size-4 text-accent" />}
                    </button>
                  );
                })}
              </div>
              <button className="h-11 w-full rounded-lg bg-accent text-sm font-medium text-accent-fg disabled:opacity-40" disabled={groupPicks.length < 2} onClick={async () => { await api.createGroup(groupName, groupPicks); setGroupStep(0); setGroupPicks([]); await refresh(); }}>Create group</button>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-5">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-medium">{title}</h2><button onClick={onClose}><X className="size-4 text-muted" /></button></div>
        {children}
      </div>
    </div>
  );
}

function SettingsPane({ me, onSave, onSignOut }: { me: Profile; onSave: (p: Partial<Profile>) => void; onSignOut: () => void }) {
  const [form, setForm] = useState(me);
  useEffect(() => setForm(me), [me]);
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-xl space-y-3">
        <div className="h-28 overflow-hidden rounded-xl" style={{ background: form.bannerUrl ? `center/cover url(${form.bannerUrl})` : form.bannerColor }} />
        <label className="text-xs text-muted">Profile photo
          <input type="file" accept="image/*" className="mt-1 block w-full text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const url = await readFileAsData(f); setForm((p) => ({ ...p, avatarUrl: url })); }} />
        </label>
        <label className="text-xs text-muted">Banner
          <input type="file" accept="image/*" className="mt-1 block w-full text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const url = await readFileAsData(f); setForm((p) => ({ ...p, bannerUrl: url })); }} />
        </label>
        {(["displayName", "username", "email", "phone", "pronouns", "bio"] as const).map((k) => (
          <input key={k} className="h-11 w-full rounded-lg border border-border bg-elevated px-3 text-sm" placeholder={k} value={(form as never)[k] || ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
        ))}
        <div className="flex gap-2">
          <label className="text-xs text-muted">Color <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} /></label>
          <label className="text-xs text-muted">Banner color <input type="color" value={form.bannerColor} onChange={(e) => setForm({ ...form, bannerColor: e.target.value })} /></label>
        </div>
        <select className="h-11 w-full rounded-lg border border-border bg-elevated px-3 text-sm" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Status })}>
          <option value="online">Online</option>
          <option value="dnd">Do not disturb</option>
          <option value="invisible">Invisible</option>
        </select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.hideOnline} onChange={(e) => setForm({ ...form, hideOnline: e.target.checked })} /> Hide online status</label>
        <button className="h-11 w-full rounded-lg bg-accent text-sm font-medium text-accent-fg" onClick={() => onSave(form)}>Save</button>
        <button className="h-11 w-full rounded-lg bg-panel text-sm" onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  );
}

function ServerStudio({
  server, me, addMember, setAddMember, addChannel, setAddChannel, channelName, setChannelName, onUpdate, onAddMember, onCreateChannel, onDeleteChannel,
}: {
  server: Server; me: Profile; addMember: string; setAddMember: (v: string) => void; addChannel: "text" | "voice" | null; setAddChannel: (v: "text" | "voice" | null) => void; channelName: string; setChannelName: (v: string) => void;
  onUpdate: (p: Partial<Server>) => void; onAddMember: () => void; onCreateChannel: () => void; onDeleteChannel: (id: string) => void;
}) {
  const [form, setForm] = useState(server);
  useEffect(() => setForm(server), [server]);
  if (server.ownerId !== me.userId) return <div className="p-6 text-sm text-muted">Only the owner can edit this server.</div>;
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-xl space-y-3">
        <div className="h-28 overflow-hidden rounded-xl" style={{ background: form.bannerUrl ? `center/cover url(${form.bannerUrl})` : form.bannerColor }} />
        <label className="text-xs text-muted">Icon <input type="file" accept="image/*" className="mt-1 block w-full text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const url = await readFileAsData(f); const next = { ...form, iconUrl: url }; setForm(next); onUpdate(next); }} /></label>
        <label className="text-xs text-muted">Banner <input type="file" accept="image/*" className="mt-1 block w-full text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const url = await readFileAsData(f); const next = { ...form, bannerUrl: url }; setForm(next); onUpdate(next); }} /></label>
        <input className="h-11 w-full rounded-lg border border-border bg-elevated px-3 text-sm" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="h-11 w-full rounded-lg border border-border bg-elevated px-3 text-sm" placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <input className="h-11 w-full rounded-lg border border-border bg-elevated px-3 text-sm" placeholder="Welcome message" value={form.welcome} onChange={(e) => setForm({ ...form, welcome: e.target.value })} />
        <button className="h-11 w-full rounded-lg bg-accent text-sm font-medium text-accent-fg" onClick={() => onUpdate(form)}>Save server</button>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); onAddMember(); }}>
          <input className="h-11 flex-1 rounded-lg border border-border bg-elevated px-3 text-sm" placeholder="Add friend by username" value={addMember} onChange={(e) => setAddMember(e.target.value)} />
          <button className="h-11 rounded-lg bg-panel px-3 text-sm">Add</button>
        </form>
        <div className="flex gap-2">
          <button className="h-10 flex-1 rounded-lg bg-panel text-sm" onClick={() => setAddChannel("text")}>New text channel</button>
          <button className="h-10 flex-1 rounded-lg bg-panel text-sm" onClick={() => setAddChannel("voice")}>New call lobby</button>
        </div>
        {addChannel && (
          <div className="flex gap-2">
            <input className="h-11 flex-1 rounded-lg border border-border bg-elevated px-3 text-sm" placeholder={addChannel === "voice" ? "Lobby name" : "Channel name"} value={channelName} onChange={(e) => setChannelName(e.target.value)} />
            <button className="h-11 rounded-lg bg-accent px-3 text-sm text-accent-fg" onClick={onCreateChannel}>Create</button>
          </div>
        )}
        {server.channels.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-lg bg-elevated px-3 py-2 text-sm">
            <span>{c.type === "voice" ? "Call" : "#"} {c.name}</span>
            <button className="text-danger" onClick={() => onDeleteChannel(c.id)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function pickScreen(stream: MediaStream | null) {
  return stream?.getVideoTracks().find((t) => t.readyState === "live" && isScreenTrack(t)) || null;
}
function pickCam(stream: MediaStream | null) {
  return stream?.getVideoTracks().find((t) => t.readyState === "live" && t.enabled && !isScreenTrack(t)) || null;
}

function MediaTile({ name, stream, extra, self, large, muted }: { name: string; stream: MediaStream | null; extra?: MediaStream | null; self?: boolean; large?: boolean; muted?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const screen = pickScreen(extra || stream);
  const cam = pickCam(stream);
  const show = screen || cam;
  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.srcObject = show ? new MediaStream([show]) : null;
  }, [show, stream, extra]);
  useEffect(() => {
    if (self || !audioRef.current || !stream) return;
    audioRef.current.srcObject = new MediaStream(stream.getAudioTracks());
  }, [stream, self]);
  return (
    <div className={`relative grid place-items-center overflow-hidden rounded-xl border border-border bg-bg ${large ? "col-span-full aspect-video min-h-56" : "aspect-video"}`}>
      {!self && <audio ref={audioRef} autoPlay />}
      {show ? <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" /> : <div className="grid size-16 place-items-center rounded-full bg-panel text-xl">{name.slice(0, 1).toUpperCase()}</div>}
      <div className="absolute bottom-2 left-2 rounded-md bg-bg/80 px-2 py-1 text-xs">{name}{self ? " · you" : ""}{muted ? " · muted" : ""}{screen ? " · screen" : ""}</div>
    </div>
  );
}

function CallButtons({ compact }: { compact?: boolean }) {
  const size = compact ? "size-10" : "size-11";
  const muted = isMuted();
  const camOn = hasCamera();
  const sharing = isSharingScreen();
  return (
    <>
      <button className={`${size} rounded-full ${muted ? "bg-danger" : "bg-panel"}`} onClick={() => toggleVoiceMute()}>{muted ? <MicOff className="mx-auto size-4" /> : <Mic className="mx-auto size-4" />}</button>
      <button className={`${size} rounded-full ${camOn ? "bg-success text-accent-fg" : "bg-panel"}`} onClick={() => void toggleVoiceCamera()}>{camOn ? <Video className="mx-auto size-4" /> : <VideoOff className="mx-auto size-4" />}</button>
      <button className={`${size} rounded-full ${sharing ? "bg-accent text-accent-fg" : "bg-panel"}`} onClick={() => void shareVoiceScreen()}><MonitorUp className="mx-auto size-4" /></button>
      <button className={`${size} rounded-full bg-danger`} onClick={() => void hangUp()}><PhoneOff className="mx-auto size-4" /></button>
    </>
  );
}

function VoiceStage() {
  const [, bump] = useState(0);
  useEffect(() => onVoiceChange(() => bump((n) => n + 1)), []);
  const room = getVoiceRoom();
  const peers = getVoicePeers();
  const remotes = getVoiceRemotes();
  const local = getVoiceLocal();
  const screen = getVoiceScreen();
  if (!room) return <div className="grid flex-1 place-items-center text-sm text-muted">Start a call from a friend, group, or lobby.</div>;
  const remoteScreen = remotes.find(([, st]) => pickScreen(st));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid flex-1 grid-cols-1 gap-3 overflow-y-auto p-4 sm:grid-cols-2 xl:grid-cols-3">
        {(isSharingScreen() || remoteScreen) && (
          <MediaTile large name={isSharingScreen() ? "Your screen" : "Screen"} stream={isSharingScreen() ? screen : remoteScreen?.[1] || null} extra={isSharingScreen() ? screen : remoteScreen?.[1] || null} self={isSharingScreen()} />
        )}
        <MediaTile name="You" stream={local} extra={screen} self muted={isMuted()} />
        {peers.map((p) => <MediaTile key={p.userId} name={p.username} stream={remotes.find(([id]) => id === p.userId)?.[1] || null} />)}
      </div>
      <div className="flex h-16 items-center justify-center gap-2 border-t border-border"><CallButtons /></div>
    </div>
  );
}

function VoiceDock() {
  const [, bump] = useState(0);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => onVoiceChange(() => bump((n) => n + 1)), []);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!drag.current) return;
      const w = box.current?.offsetWidth ?? 320;
      const h = box.current?.offsetHeight ?? 160;
      setPos({ x: Math.max(8, Math.min(window.innerWidth - w - 8, e.clientX - drag.current.dx)), y: Math.max(8, Math.min(window.innerHeight - h - 8, e.clientY - drag.current.dy)) });
    };
    const onUp = () => { drag.current = null; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, []);
  const room = getVoiceRoom();
  if (!room) return null;
  const style = pos ? { left: pos.x, top: pos.y, transform: "none" as const } : { left: "50%", bottom: 28, transform: "translateX(-50%)" };
  return (
    <div ref={box} className="fixed z-40 w-[min(360px,calc(100vw-24px))] rounded-2xl border border-border bg-elevated/95 p-3 shadow-2xl" style={style}>
      <button className="mb-2 flex w-full cursor-grab justify-center text-subtle" onPointerDown={(e) => { const rect = box.current?.getBoundingClientRect(); if (!rect) return; if (!pos) setPos({ x: rect.left, y: rect.top }); drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }; }}>
        <GripHorizontal className="size-4" />
      </button>
      <div className="text-[11px] uppercase text-muted">In call</div>
      <div className="font-medium">{room.label}</div>
      <div className="mb-3 text-xs text-muted">You{getVoicePeers().length ? ` + ${getVoicePeers().length}` : " · waiting"}</div>
      <div className="flex justify-center gap-2"><CallButtons compact /></div>
    </div>
  );
}
